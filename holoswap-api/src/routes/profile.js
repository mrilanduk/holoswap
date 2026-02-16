const { Router } = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = Router();

// GET /api/profile — get current user's profile
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, display_name, avatar_url, city, postcode, bio, is_pro, is_admin, is_vendor, vendor_code, created_at, address_line1, address_line2, county, country FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get card, want and traded counts
    const cardCount = await pool.query("SELECT COUNT(*) FROM cards WHERE user_id = $1 AND status NOT IN ('traded', 'returned')", [req.user.id]);
    const wantCount = await pool.query('SELECT COUNT(*) FROM want_list WHERE user_id = $1', [req.user.id]);
    const tradedCount = await pool.query(
      "SELECT COUNT(*) FROM trades WHERE (seller_id = $1 OR buyer_id = $1) AND status = 'complete'",
      [req.user.id]
    );

    res.json({
      user: result.rows[0],
      stats: {
        cards: parseInt(cardCount.rows[0].count),
        wants: parseInt(wantCount.rows[0].count),
        traded: parseInt(tradedCount.rows[0].count),
      }
    });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/profile — update profile
router.put('/', auth, async (req, res) => {
  try {
    const { display_name, city, postcode, bio, address_line1, address_line2, county, country } = req.body;

    const result = await pool.query(
      `UPDATE users SET
        display_name = COALESCE($1, display_name),
        city = COALESCE($2, city),
        postcode = COALESCE($3, postcode),
        bio = COALESCE($4, bio),
        address_line1 = COALESCE($5, address_line1),
        address_line2 = COALESCE($6, address_line2),
        county = COALESCE($7, county),
        country = COALESCE($8, country),
        updated_at = NOW()
       WHERE id = $9
       RETURNING id, email, display_name, avatar_url, city, postcode, bio, is_pro, address_line1, address_line2, county, country`,
      [display_name, city, postcode, bio, address_line1, address_line2, county, country, req.user.id]
    );

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
