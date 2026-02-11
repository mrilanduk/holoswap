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

// PUT /api/admin/users/:id — update user (make admin, pro, etc)
router.put('/users/:id', auth, requireAdmin, async (req, res) => {
  try {
    const { is_admin, is_pro } = req.body;

    const result = await pool.query(
      `UPDATE users SET
        is_admin = COALESCE($1, is_admin),
        is_pro = COALESCE($2, is_pro),
        updated_at = NOW()
       WHERE id = $3
       RETURNING id, email, display_name, is_admin, is_pro`,
      [is_admin, is_pro, req.params.id]
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

module.exports = router;
