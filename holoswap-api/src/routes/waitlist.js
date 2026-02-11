const { Router } = require('express');
const pool = require('../db');

const router = Router();

// POST /api/waitlist — add email to waitlist
router.post('/', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.includes('@') || !email.includes('.')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const normalised = email.toLowerCase().trim();

    // Insert (ignore duplicates)
    const result = await pool.query(
      `INSERT INTO waitlist (email, ip_address)
       VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, created_at`,
      [normalised, req.ip]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({
        message: 'Already on the waitlist!',
        already_exists: true,
      });
    }

    // Get total count for social proof
    const countResult = await pool.query('SELECT COUNT(*) FROM waitlist');

    res.status(201).json({
      message: 'Welcome to the waitlist!',
      already_exists: false,
      position: parseInt(countResult.rows[0].count),
    });
  } catch (err) {
    console.error('Waitlist error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /api/waitlist/count — public count for landing page
router.get('/count', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM waitlist');
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('Count error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
