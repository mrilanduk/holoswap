const { Router } = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = Router();

// Middleware: check if user is admin
async function requireAdmin(req, res, next) {
  try {
    const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0 || !result.rows[0].is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
}

// GET /api/admin/stats — platform overview
router.get('/stats', auth, requireAdmin, async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) FROM users');
    const waitlist = await pool.query('SELECT COUNT(*) FROM waitlist');
    const cards = await pool.query('SELECT COUNT(*) FROM cards');
    const wants = await pool.query('SELECT COUNT(*) FROM want_list');
    const listedCards = await pool.query("SELECT COUNT(*) FROM cards WHERE status = 'listed'");
    const verifiedCards = await pool.query("SELECT COUNT(*) FROM cards WHERE status = 'verified'");
    const tradedCards = await pool.query("SELECT COUNT(*) FROM cards WHERE status = 'traded'");

    // Trade stats
    const activeTrades = await pool.query(
      "SELECT COUNT(*) FROM trades WHERE status NOT IN ('cancelled', 'rejected', 'complete')"
    );
    const completedTrades = await pool.query(
      "SELECT COUNT(*) FROM trades WHERE status = 'complete'"
    );
    const awaitingReceive = await pool.query(
      "SELECT COUNT(*) FROM trades WHERE status = 'shipped'"
    );
    const awaitingVerify = await pool.query(
      "SELECT COUNT(*) FROM trades WHERE status = 'received'"
    );

    const recentUsers = await pool.query(
      "SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days'"
    );

    res.json({
      users: parseInt(users.rows[0].count),
      waitlist: parseInt(waitlist.rows[0].count),
      total_cards: parseInt(cards.rows[0].count),
      total_wants: parseInt(wants.rows[0].count),
      listed_cards: parseInt(listedCards.rows[0].count),
      verified_cards: parseInt(verifiedCards.rows[0].count),
      traded_cards: parseInt(tradedCards.rows[0].count),
      active_trades: parseInt(activeTrades.rows[0].count),
      completed_trades: parseInt(completedTrades.rows[0].count),
      awaiting_receive: parseInt(awaitingReceive.rows[0].count),
      awaiting_verify: parseInt(awaitingVerify.rows[0].count),
      recent_users_7d: parseInt(recentUsers.rows[0].count),
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /api/admin/trades — list all trades for admin management
router.get('/trades', auth, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || '';
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (status) {
      conditions.push(`t.status = $${paramIdx++}`);
      params.push(status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT t.*,
        seller.email as seller_email, seller.display_name as seller_name,
        buyer.email as buyer_email, buyer.display_name as buyer_name,
        buyer.address_line1 as buyer_addr1, buyer.address_line2 as buyer_addr2,
        buyer.city as buyer_city, buyer.county as buyer_county,
        buyer.postcode as buyer_postcode, buyer.country as buyer_country,
        c.card_name, c.card_set, c.card_number, c.rarity, c.condition,
        c.image_url, c.status as card_status, c.estimated_value
       FROM trades t
       JOIN users seller ON t.seller_id = seller.id
       JOIN users buyer ON t.buyer_id = buyer.id
       JOIN cards c ON t.card_id = c.id
       ${where}
       ORDER BY
         CASE t.status
           WHEN 'shipped' THEN 1
           WHEN 'received' THEN 2
           WHEN 'verified' THEN 3
           WHEN 'accepted' THEN 4
           WHEN 'requested' THEN 5
           ELSE 6
         END,
         t.updated_at DESC`,
      params
    );

    res.json({ trades: result.rows });
  } catch (err) {
    console.error('Admin trades error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/received — admin marks card as received at HoloSwap
router.put('/trades/:id/received', auth, requireAdmin, async (req, res) => {
  try {
    const trade = await pool.query(
      "SELECT * FROM trades WHERE id = $1 AND status = 'shipped'",
      [req.params.id]
    );
    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or not in shipped status' });
    }

    await pool.query(
      "UPDATE trades SET status = 'received', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );
    await pool.query(
      "UPDATE cards SET status = 'received', updated_at = NOW() WHERE id = $1",
      [trade.rows[0].card_id]
    );

    res.json({ message: 'Card marked as received. Ready for verification.' });
  } catch (err) {
    console.error('Admin receive error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/verified — admin verifies card authenticity & condition
router.put('/trades/:id/verified', auth, requireAdmin, async (req, res) => {
  try {
    const { condition_notes, verified_condition } = req.body;

    const trade = await pool.query(
      "SELECT * FROM trades WHERE id = $1 AND status = 'received'",
      [req.params.id]
    );
    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or not in received status' });
    }

    // Update trade — now awaiting payment from buyer
    await pool.query(
      `UPDATE trades SET status = 'verified', notes = $1, updated_at = NOW() WHERE id = $2`,
      [condition_notes || null, req.params.id]
    );

    // Update card
    await pool.query(
      `UPDATE cards SET status = 'verified', condition = COALESCE($1, condition),
       verified_at = NOW(), verified_by = $2, updated_at = NOW() WHERE id = $3`,
      [verified_condition || null, req.user.id, trade.rows[0].card_id]
    );

    res.json({ message: 'Card verified! Awaiting buyer payment.' });
  } catch (err) {
    console.error('Admin verify error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/rejected — admin rejects card
router.put('/trades/:id/rejected', auth, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;

    const trade = await pool.query(
      "SELECT * FROM trades WHERE id = $1 AND status = 'received'",
      [req.params.id]
    );
    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or not in received status' });
    }

    await pool.query(
      "UPDATE trades SET status = 'rejected', notes = $1, updated_at = NOW() WHERE id = $2",
      [reason || 'Card did not pass authentication', req.params.id]
    );
    await pool.query(
      "UPDATE cards SET status = 'rejected', updated_at = NOW() WHERE id = $1",
      [trade.rows[0].card_id]
    );

    res.json({ message: 'Card rejected. Card will be returned to seller.' });
  } catch (err) {
    console.error('Admin reject error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/payment-received — admin confirms buyer payment
router.put('/trades/:id/payment-received', auth, requireAdmin, async (req, res) => {
  try {
    const { payment_method, payment_id, price, holoswap_fee } = req.body;

    const trade = await pool.query(
      "SELECT * FROM trades WHERE id = $1 AND status = 'verified'",
      [req.params.id]
    );
    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or not verified' });
    }

    await pool.query(
      `UPDATE trades SET payment_status = 'paid', payment_method = $1, payment_id = $2,
       price = COALESCE($3, price), holoswap_fee = $4, updated_at = NOW() WHERE id = $5`,
      [payment_method || null, payment_id || null, price, holoswap_fee || null, req.params.id]
    );

    res.json({ message: 'Payment recorded. Ready to ship to buyer.' });
  } catch (err) {
    console.error('Admin payment error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/ship-to-buyer — admin ships card to buyer
router.put('/trades/:id/ship-to-buyer', auth, requireAdmin, async (req, res) => {
  try {
    const { outbound_tracking } = req.body;

    const trade = await pool.query(
      "SELECT * FROM trades WHERE id = $1 AND status = 'verified' AND payment_status = 'paid'",
      [req.params.id]
    );
    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or payment not received' });
    }

    await pool.query(
      `UPDATE trades SET status = 'dispatched', outbound_tracking = $1, updated_at = NOW() WHERE id = $2`,
      [outbound_tracking || null, req.params.id]
    );
    await pool.query(
      "UPDATE cards SET status = 'dispatched', updated_at = NOW() WHERE id = $1",
      [trade.rows[0].card_id]
    );

    res.json({ message: 'Card dispatched to buyer!' });
  } catch (err) {
    console.error('Admin ship error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/complete — admin marks trade as complete
router.put('/trades/:id/complete', auth, requireAdmin, async (req, res) => {
  try {
    const trade = await pool.query(
      "SELECT * FROM trades WHERE id = $1 AND status = 'dispatched'",
      [req.params.id]
    );
    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or not dispatched' });
    }

    await pool.query(
      "UPDATE trades SET status = 'complete', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );
    await pool.query(
      "UPDATE cards SET status = 'traded', updated_at = NOW() WHERE id = $1",
      [trade.rows[0].card_id]
    );

    res.json({ message: 'Trade complete!' });
  } catch (err) {
    console.error('Admin complete error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/pay-seller — admin marks seller as paid
router.put('/trades/:id/pay-seller', auth, requireAdmin, async (req, res) => {
  try {
    const { payment_method, payment_id } = req.body;

    await pool.query(
      `UPDATE trades SET seller_paid = TRUE, updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    res.json({ message: 'Seller payment recorded' });
  } catch (err) {
    console.error('Admin pay seller error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /api/admin/users — list all users
router.get('/users', auth, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * 50;
    const search = req.query.search || '';

    let where = '';
    const params = [];

    if (search) {
      where = 'WHERE LOWER(email) LIKE $1 OR LOWER(display_name) LIKE $1';
      params.push(`%${search.toLowerCase()}%`);
    }

    const countResult = await pool.query(`SELECT COUNT(*) FROM users ${where}`, params);

    const result = await pool.query(
      `SELECT id, email, display_name, city, postcode, is_pro, is_admin, created_at,
              (SELECT COUNT(*) FROM cards WHERE cards.user_id = users.id) as card_count,
              (SELECT COUNT(*) FROM want_list WHERE want_list.user_id = users.id) as want_count
       FROM users ${where}
       ORDER BY created_at DESC
       LIMIT 50 OFFSET $${params.length + 1}`,
      [...params, offset]
    );

    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      pages: Math.ceil(parseInt(countResult.rows[0].count) / 50),
    });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /api/admin/waitlist
router.get('/waitlist', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM waitlist ORDER BY created_at DESC');
    res.json({ waitlist: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /api/admin/cards
router.get('/cards', auth, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * 50;
    const status = req.query.status || '';
    const search = req.query.search || '';

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (status) {
      conditions.push(`cards.status = $${paramIdx++}`);
      params.push(status);
    }
    if (search) {
      conditions.push(`(LOWER(cards.card_name) LIKE $${paramIdx} OR LOWER(users.email) LIKE $${paramIdx})`);
      params.push(`%${search.toLowerCase()}%`);
      paramIdx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT cards.*, users.email as user_email, users.display_name as user_name
       FROM cards JOIN users ON cards.user_id = users.id ${where}
       ORDER BY cards.created_at DESC
       LIMIT 50 OFFSET $${paramIdx}`,
      [...params, offset]
    );

    res.json({ cards: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/cards/:id/status
router.put('/cards/:id/status', auth, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const result = await pool.query(
      'UPDATE cards SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Card not found' });
    res.json({ card: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/users/:id
router.put('/users/:id', auth, requireAdmin, async (req, res) => {
  try {
    const { is_admin, is_pro } = req.body;
    const result = await pool.query(
      `UPDATE users SET is_admin = COALESCE($1, is_admin), is_pro = COALESCE($2, is_pro), updated_at = NOW()
       WHERE id = $3 RETURNING id, email, display_name, is_admin, is_pro`,
      [is_admin, is_pro, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
