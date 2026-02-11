const { Router } = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = Router();

// GET /api/cards — get user's cards
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM cards WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ cards: result.rows });
  } catch (err) {
    console.error('Get cards error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /api/cards — add a card to user's have list
router.post('/', auth, async (req, res) => {
  try {
    const { card_name, card_set, card_number, rarity, condition, notes, image_url } = req.body;

    if (!card_name) {
      return res.status(400).json({ error: 'Card name is required' });
    }

    const result = await pool.query(
      `INSERT INTO cards (user_id, card_name, card_set, card_number, rarity, condition, notes, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.user.id, card_name, card_set || null, card_number || null, rarity || null,
       condition || 'unknown', notes || null, image_url || null]
    );

    res.status(201).json({ card: result.rows[0] });
  } catch (err) {
    console.error('Add card error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/cards/:id — update a card
router.put('/:id', auth, async (req, res) => {
  try {
    const { card_name, card_set, card_number, rarity, condition, notes, image_url } = req.body;

    const result = await pool.query(
      `UPDATE cards SET card_name = COALESCE($1, card_name), card_set = COALESCE($2, card_set),
       card_number = COALESCE($3, card_number), rarity = COALESCE($4, rarity),
       condition = COALESCE($5, condition), notes = COALESCE($6, notes),
       image_url = COALESCE($7, image_url), updated_at = NOW()
       WHERE id = $8 AND user_id = $9
       RETURNING *`,
      [card_name, card_set, card_number, rarity, condition, notes, image_url,
       req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    res.json({ card: result.rows[0] });
  } catch (err) {
    console.error('Update card error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// DELETE /api/cards/:id — remove a card
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM cards WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    res.json({ message: 'Card removed' });
  } catch (err) {
    console.error('Delete card error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
