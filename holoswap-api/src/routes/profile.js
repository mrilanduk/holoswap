const { Router } = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = Router();

// GET /api/profile — get current user's profile
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, display_name, avatar_url, address_line1, address_line2,
              city, county, postcode, country, bio, is_pro, is_admin, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const cardCount = await pool.query('SELECT COUNT(*) FROM cards WHERE user_id = $1', [req.user.id]);
    const wantCount = await pool.query('SELECT COUNT(*) FROM want_list WHERE user_id = $1', [req.user.id]);

    res.json({
      user: result.rows[0],
      stats: {
        cards: parseInt(cardCount.rows[0].count),
        wants: parseInt(wantCount.rows[0].count),
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
    const { display_name, address_line1, address_line2, city, county, postcode, country, bio } = req.body;

    const result = await pool.query(
      `UPDATE users SET
        display_name = COALESCE($1, display_name),
        address_line1 = COALESCE($2, address_line1),
        address_line2 = COALESCE($3, address_line2),
        city = COALESCE($4, city),
        county = COALESCE($5, county),
        postcode = COALESCE($6, postcode),
        country = COALESCE($7, country),
        bio = COALESCE($8, bio),
        updated_at = NOW()
       WHERE id = $9
       RETURNING id, email, display_name, avatar_url, address_line1, address_line2,
                 city, county, postcode, country, bio, is_pro, is_admin`,
      [display_name, address_line1, address_line2, city, county, postcode, country, bio, req.user.id]
    );

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /api/profile/address-check — check if user has a delivery address
router.get('/address-check', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT address_line1, city, postcode FROM users WHERE id = $1`,
      [req.user.id]
    );
    const u = result.rows[0];
    const hasAddress = !!(u.address_line1 && u.city && u.postcode);
    res.json({ hasAddress });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
