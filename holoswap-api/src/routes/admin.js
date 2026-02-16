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

    // Recent signups (last 7 days)
    const recentUsers = await pool.query(
      "SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days'"
    );
    const recentWaitlist = await pool.query(
      "SELECT COUNT(*) FROM waitlist WHERE created_at > NOW() - INTERVAL '7 days'"
    );

    res.json({
      users: parseInt(users.rows[0].count),
      waitlist: parseInt(waitlist.rows[0].count),
      total_cards: parseInt(cards.rows[0].count),
      total_wants: parseInt(wants.rows[0].count),
      listed_cards: parseInt(listedCards.rows[0].count),
      verified_cards: parseInt(verifiedCards.rows[0].count),
      traded_cards: parseInt(tradedCards.rows[0].count),
      recent_users_7d: parseInt(recentUsers.rows[0].count),
      recent_waitlist_7d: parseInt(recentWaitlist.rows[0].count),
    });
  } catch (err) {
    console.error('Admin stats error:', err);
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
      `SELECT id, email, display_name, city, postcode, is_pro, is_admin, is_vendor, vendor_code, created_at,
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

// GET /api/admin/waitlist — list all waitlist signups
router.get('/waitlist', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM waitlist ORDER BY created_at DESC'
    );
    res.json({ waitlist: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('Admin waitlist error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /api/admin/cards — list all cards across all users
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
      conditions.push(`(LOWER(cards.card_name) LIKE $${paramIdx} OR LOWER(users.email) LIKE $${paramIdx} OR LOWER(users.display_name) LIKE $${paramIdx})`);
      params.push(`%${search.toLowerCase()}%`);
      paramIdx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM cards JOIN users ON cards.user_id = users.id ${where}`,
      params
    );

    const result = await pool.query(
      `SELECT cards.*, users.email as user_email, users.display_name as user_name
       FROM cards
       JOIN users ON cards.user_id = users.id
       ${where}
       ORDER BY cards.created_at DESC
       LIMIT 50 OFFSET $${paramIdx}`,
      [...params, offset]
    );

    res.json({
      cards: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      pages: Math.ceil(parseInt(countResult.rows[0].count) / 50),
    });
  } catch (err) {
    console.error('Admin cards error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/cards/:id/status — update card status (verify/reject)
router.put('/cards/:id/status', auth, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['listed', 'shipped', 'received', 'verifying', 'verified', 'rejected', 'traded', 'returned'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const updates = ['status = $1', 'updated_at = NOW()'];
    const params = [status];

    if (status === 'verified') {
      updates.push(`verified_at = NOW()`);
      updates.push(`verified_by = $${params.length + 1}`);
      params.push(req.user.id);
    }

    params.push(req.params.id);

    const result = await pool.query(
      `UPDATE cards SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    res.json({ card: result.rows[0] });
  } catch (err) {
    console.error('Admin update card error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/users/:id — update user (make admin, pro, vendor, etc)
router.put('/users/:id', auth, requireAdmin, async (req, res) => {
  try {
    const { is_admin, is_pro, is_vendor, vendor_code } = req.body;

    const result = await pool.query(
      `UPDATE users SET
        is_admin = COALESCE($1, is_admin),
        is_pro = COALESCE($2, is_pro),
        is_vendor = COALESCE($3, is_vendor),
        vendor_code = CASE WHEN $3 = true THEN COALESCE($4, vendor_code) ELSE NULL END,
        updated_at = NOW()
       WHERE id = $5
       RETURNING id, email, display_name, is_admin, is_pro, is_vendor, vendor_code`,
      [is_admin, is_pro, is_vendor, vendor_code || null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Admin update user error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /api/admin/vendors — vendor insights for admin
router.get('/vendors', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.vendor_code, u.created_at,
              (SELECT COUNT(*) FROM vending_lookups WHERE vendor_id = u.id) as total_lookups,
              (SELECT COUNT(*) FROM vending_lookups WHERE vendor_id = u.id AND status = 'completed' AND COALESCE(type, 'sell') = 'sell') as total_sales_count,
              (SELECT COALESCE(SUM(sale_price), 0) FROM vending_lookups WHERE vendor_id = u.id AND status = 'completed' AND COALESCE(type, 'sell') = 'sell') as total_sales_value,
              (SELECT COUNT(*) FROM vending_lookups WHERE vendor_id = u.id AND status = 'completed' AND COALESCE(type, 'sell') = 'buy') as total_buys_count,
              (SELECT COALESCE(SUM(sale_price), 0) FROM vending_lookups WHERE vendor_id = u.id AND status = 'completed' AND COALESCE(type, 'sell') = 'buy') as total_buys_value,
              (SELECT COUNT(*) FROM vending_lookups WHERE vendor_id = u.id AND status = 'pending') as pending_count
       FROM users u
       WHERE u.is_vendor = true
       ORDER BY u.created_at DESC`
    );
    res.json({ vendors: result.rows });
  } catch (err) {
    console.error('Admin vendors error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// =====================
// TRADE ADMIN ENDPOINTS
// =====================

// GET /api/admin/trades — list trades with optional status filter
router.get('/trades', auth, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || '';
    let where = '';
    const params = [];

    if (status) {
      where = 'WHERE t.status = $1';
      params.push(status);
    }

    const result = await pool.query(
      `SELECT t.*,
        seller.display_name as seller_name, seller.email as seller_email,
        buyer.display_name as buyer_name, buyer.email as buyer_email,
        buyer.address_line1, buyer.address_line2, buyer.city as buyer_city,
        buyer.county as buyer_county, buyer.postcode as buyer_postcode,
        buyer.country as buyer_country,
        c.card_name, c.card_set, c.card_number, c.condition, c.image_url
       FROM trades t
       JOIN users seller ON t.seller_id = seller.id
       JOIN users buyer ON t.buyer_id = buyer.id
       JOIN cards c ON t.card_id = c.id
       ${where}
       ORDER BY t.created_at DESC`,
      params
    );

    res.json({ trades: result.rows });
  } catch (err) {
    console.error('Admin trades error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/received — mark card received at HoloSwap
router.put('/trades/:id/received', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE trades SET status = 'received', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trade not found' });

    // Also update card status
    await pool.query(
      `UPDATE cards SET status = 'received', updated_at = NOW() WHERE id = $1`,
      [result.rows[0].card_id]
    );

    res.json({ trade: result.rows[0] });
  } catch (err) {
    console.error('Admin receive error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/verified — verify card authenticity
router.put('/trades/:id/verified', auth, requireAdmin, async (req, res) => {
  try {
    const { condition_notes } = req.body || {};
    const result = await pool.query(
      `UPDATE trades SET status = 'verified', notes = COALESCE(notes, '') || $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [condition_notes ? ` | Verified: ${condition_notes}` : ' | Verified', req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trade not found' });

    await pool.query(
      `UPDATE cards SET status = 'verified', verified_at = NOW(), verified_by = $1, updated_at = NOW() WHERE id = $2`,
      [req.user.id, result.rows[0].card_id]
    );

    res.json({ trade: result.rows[0] });
  } catch (err) {
    console.error('Admin verify error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/rejected — reject card
router.put('/trades/:id/rejected', auth, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body || {};
    const result = await pool.query(
      `UPDATE trades SET status = 'rejected', notes = COALESCE(notes, '') || $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [reason ? ` | Rejected: ${reason}` : ' | Rejected', req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trade not found' });

    await pool.query(
      `UPDATE cards SET status = 'rejected', updated_at = NOW() WHERE id = $1`,
      [result.rows[0].card_id]
    );

    res.json({ trade: result.rows[0] });
  } catch (err) {
    console.error('Admin reject error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/payment-received — record buyer payment
router.put('/trades/:id/payment-received', auth, requireAdmin, async (req, res) => {
  try {
    const { payment_method, price, holoswap_fee, payment_id } = req.body || {};
    const result = await pool.query(
      `UPDATE trades SET
        payment_status = 'paid',
        payment_method = COALESCE($1, payment_method),
        price = COALESCE($2, price),
        holoswap_fee = COALESCE($3, holoswap_fee),
        payment_id = COALESCE($4, payment_id),
        updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [payment_method, price, holoswap_fee, payment_id, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trade not found' });
    res.json({ trade: result.rows[0] });
  } catch (err) {
    console.error('Admin payment error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/processed — label created, tracking assigned, ready to post
router.put('/trades/:id/processed', auth, requireAdmin, async (req, res) => {
  try {
    const { outbound_tracking } = req.body || {};
    const result = await pool.query(
      `UPDATE trades SET
        status = 'processed',
        outbound_tracking = COALESCE($1, outbound_tracking),
        updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [outbound_tracking, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trade not found' });
    res.json({ trade: result.rows[0] });
  } catch (err) {
    console.error('Admin processed error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/ship-to-buyer — mark as dispatched (RM scanned)
router.put('/trades/:id/ship-to-buyer', auth, requireAdmin, async (req, res) => {
  try {
    const { outbound_tracking } = req.body || {};
    const result = await pool.query(
      `UPDATE trades SET
        status = 'dispatched',
        outbound_tracking = COALESCE($1, outbound_tracking),
        updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [outbound_tracking, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trade not found' });
    res.json({ trade: result.rows[0] });
  } catch (err) {
    console.error('Admin dispatch error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/complete — mark trade complete, clean up want list
router.put('/trades/:id/complete', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE trades SET status = 'complete', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trade not found' });

    const trade = result.rows[0];

    // Mark card as traded
    await pool.query(
      `UPDATE cards SET status = 'traded', updated_at = NOW() WHERE id = $1`,
      [trade.card_id]
    );

    // Remove from buyer's want list
    await pool.query(
      `DELETE FROM want_list WHERE user_id = $1 AND card_set = (
        SELECT card_set FROM cards WHERE id = $2
      ) AND card_number = (
        SELECT card_number FROM cards WHERE id = $2
      )`,
      [trade.buyer_id, trade.card_id]
    );

    res.json({ trade });
  } catch (err) {
    console.error('Admin complete error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/admin/trades/:id/pay-seller — mark seller as paid
router.put('/trades/:id/pay-seller', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE trades SET seller_paid = true, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trade not found' });
    res.json({ trade: result.rows[0] });
  } catch (err) {
    console.error('Admin pay seller error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
