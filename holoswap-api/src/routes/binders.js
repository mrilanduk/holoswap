const { Router } = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = Router();

// GET /api/binders - List user's binders with card counts
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, COUNT(bc.id) as card_count
       FROM binders b
       LEFT JOIN binder_cards bc ON b.id = bc.binder_id
       WHERE b.user_id = $1
       GROUP BY b.id
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json({ binders: result.rows });
  } catch (err) {
    console.error('Get binders error:', err);
    res.status(500).json({ error: 'Failed to load binders' });
  }
});

// GET /api/binders/:id - Get single binder with all cards
router.get('/:id', auth, async (req, res) => {
  try {
    // Verify ownership
    const binderCheck = await pool.query(
      'SELECT user_id FROM binders WHERE id = $1',
      [req.params.id]
    );

    if (binderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Binder not found' });
    }

    if (binderCheck.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get binder with cards
    const result = await pool.query(
      `SELECT b.id, b.name, b.description, b.created_at, b.updated_at,
              c.id as card_id, c.card_name, c.card_set, c.card_number,
              c.rarity, c.condition, c.image_url, c.status,
              bc.id as binder_card_id, bc.position, bc.added_at
       FROM binders b
       LEFT JOIN binder_cards bc ON b.id = bc.binder_id
       LEFT JOIN cards c ON bc.card_id = c.id
       WHERE b.id = $1
       ORDER BY bc.position ASC, bc.added_at ASC`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Binder not found' });
    }

    const binder = {
      id: result.rows[0].id,
      name: result.rows[0].name,
      description: result.rows[0].description,
      created_at: result.rows[0].created_at,
      updated_at: result.rows[0].updated_at,
      cards: result.rows
        .filter(r => r.card_id !== null)
        .map(r => ({
          id: r.card_id,
          card_name: r.card_name,
          card_set: r.card_set,
          card_number: r.card_number,
          rarity: r.rarity,
          condition: r.condition,
          image_url: r.image_url,
          status: r.status,
          binder_card_id: r.binder_card_id,
          position: r.position,
          added_at: r.added_at
        }))
    };

    res.json({ binder });
  } catch (err) {
    console.error('Get binder detail error:', err);
    res.status(500).json({ error: 'Failed to load binder' });
  }
});

// POST /api/binders - Create new binder
router.post('/', auth, async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Binder name is required' });
    }

    const result = await pool.query(
      `INSERT INTO binders (user_id, name, description)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.user.id, name.trim(), description || null]
    );

    res.status(201).json({ binder: result.rows[0] });
  } catch (err) {
    console.error('Create binder error:', err);
    res.status(500).json({ error: 'Failed to create binder' });
  }
});

// PUT /api/binders/:id - Update binder
router.put('/:id', auth, async (req, res) => {
  try {
    const { name, description } = req.body;

    const result = await pool.query(
      `UPDATE binders
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           updated_at = NOW()
       WHERE id = $3 AND user_id = $4
       RETURNING *`,
      [name, description, req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Binder not found' });
    }

    res.json({ binder: result.rows[0] });
  } catch (err) {
    console.error('Update binder error:', err);
    res.status(500).json({ error: 'Failed to update binder' });
  }
});

// DELETE /api/binders/:id - Delete binder
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM binders WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Binder not found' });
    }

    res.json({ message: 'Binder deleted' });
  } catch (err) {
    console.error('Delete binder error:', err);
    res.status(500).json({ error: 'Failed to delete binder' });
  }
});

// POST /api/binders/:id/cards - Add card to binder
router.post('/:id/cards', auth, async (req, res) => {
  try {
    const { card_id } = req.body;

    if (!card_id) {
      return res.status(400).json({ error: 'Card ID is required' });
    }

    // Verify binder ownership
    const binder = await pool.query(
      'SELECT id FROM binders WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (binder.rows.length === 0) {
      return res.status(404).json({ error: 'Binder not found' });
    }

    // Verify card ownership
    const card = await pool.query(
      'SELECT id FROM cards WHERE id = $1 AND user_id = $2',
      [card_id, req.user.id]
    );

    if (card.rows.length === 0) {
      return res.status(400).json({ error: 'Card not found or access denied' });
    }

    // Get max position for this binder
    const maxPos = await pool.query(
      'SELECT COALESCE(MAX(position), -1) as max_pos FROM binder_cards WHERE binder_id = $1',
      [req.params.id]
    );

    const nextPosition = maxPos.rows[0].max_pos + 1;

    // Add card to binder
    const result = await pool.query(
      `INSERT INTO binder_cards (binder_id, card_id, position)
       VALUES ($1, $2, $3)
       ON CONFLICT (binder_id, card_id) DO NOTHING
       RETURNING *`,
      [req.params.id, card_id, nextPosition]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'Card already in binder' });
    }

    res.status(201).json({ binder_card: result.rows[0] });
  } catch (err) {
    console.error('Add card to binder error:', err);
    res.status(500).json({ error: 'Failed to add card to binder' });
  }
});

// DELETE /api/binders/:id/cards/:cardId - Remove card from binder
router.delete('/:id/cards/:cardId', auth, async (req, res) => {
  try {
    // Verify binder ownership
    const binder = await pool.query(
      'SELECT id FROM binders WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (binder.rows.length === 0) {
      return res.status(404).json({ error: 'Binder not found' });
    }

    const result = await pool.query(
      'DELETE FROM binder_cards WHERE binder_id = $1 AND card_id = $2 RETURNING id',
      [req.params.id, req.params.cardId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Card not in binder' });
    }

    res.json({ message: 'Card removed from binder' });
  } catch (err) {
    console.error('Remove card from binder error:', err);
    res.status(500).json({ error: 'Failed to remove card from binder' });
  }
});

// PUT /api/binders/:id/cards/:cardId - Update card position
router.put('/:id/cards/:cardId', auth, async (req, res) => {
  try {
    const { position } = req.body;

    if (position === undefined || position < 0) {
      return res.status(400).json({ error: 'Valid position is required' });
    }

    // Verify binder ownership
    const binder = await pool.query(
      'SELECT id FROM binders WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (binder.rows.length === 0) {
      return res.status(404).json({ error: 'Binder not found' });
    }

    const result = await pool.query(
      'UPDATE binder_cards SET position = $1 WHERE binder_id = $2 AND card_id = $3 RETURNING *',
      [position, req.params.id, req.params.cardId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Card not in binder' });
    }

    res.json({ binder_card: result.rows[0] });
  } catch (err) {
    console.error('Update card position error:', err);
    res.status(500).json({ error: 'Failed to update card position' });
  }
});

module.exports = router;
