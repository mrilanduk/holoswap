const { Router } = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = Router();

// GET /api/wants — get user's want list
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM want_list WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ wants: result.rows });
  } catch (err) {
    console.error('Get wants error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /api/wants — add a card to want list
router.post('/', auth, async (req, res) => {
  try {
    const { card_name, card_set, card_number, rarity, min_condition, notes } = req.body;

    if (!card_name) {
      return res.status(400).json({ error: 'Card name is required' });
    }

    const result = await pool.query(
      `INSERT INTO want_list (user_id, card_name, card_set, card_number, rarity, min_condition, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, card_name, card_set || null, card_number || null, rarity || null,
       min_condition || 'played', notes || null]
    );

    res.status(201).json({ want: result.rows[0] });
  } catch (err) {
    console.error('Add want error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// DELETE /api/wants/:id — remove from want list
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM want_list WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Want not found' });
    }

    res.json({ message: 'Removed from want list' });
  } catch (err) {
    console.error('Delete want error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
