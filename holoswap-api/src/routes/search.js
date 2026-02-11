const { Router } = require('express');
const pool = require('../db');

const router = Router();

// GET /api/search?q=charizard — search cards by name
// GET /api/search?q=4/102 — search by card number
router.get('/', async (req, res) => {
  try {
    const { q, set, type, rarity, category, page } = req.query;

    if (!q || q.length < 1) {
      return res.json({ data: [], total: 0 });
    }

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    const setNumberMatch = q.match(/^(\d+)\s*\/\s*(\d+)$/);

    if (setNumberMatch) {
      conditions.push(`local_id = $${paramIdx++}`);
      params.push(setNumberMatch[1]);
    } else {
      conditions.push(`LOWER(name) LIKE $${paramIdx++}`);
      params.push(`%${q.toLowerCase().trim()}%`);
    }

    if (set) {
      conditions.push(`LOWER(set_name) LIKE $${paramIdx++}`);
      params.push(`%${set.toLowerCase()}%`);
    }
    if (type) {
      conditions.push(`LOWER(card_type) LIKE $${paramIdx++}`);
      params.push(`%${type.toLowerCase()}%`);
    }
    if (rarity) {
      conditions.push(`LOWER(rarity) LIKE $${paramIdx++}`);
      params.push(`%${rarity.toLowerCase()}%`);
    }
    if (category) {
      conditions.push(`LOWER(category) = $${paramIdx++}`);
      params.push(category.toLowerCase());
    }

    const offset = ((parseInt(page) || 1) - 1) * 20;
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM card_index ${where}`, params
    );

    const result = await pool.query(
      `SELECT id, name, local_id, category, rarity, hp, card_type, stage,
              image_url, set_id, set_name, set_logo
       FROM card_index ${where}
       ORDER BY set_name, LPAD(local_id, 5, '0')
       LIMIT 20 OFFSET $${paramIdx}`,
      [...params, offset]
    );

    const data = result.rows.map(card => ({
      id: card.id,
      name: card.name,
      number: card.local_id,
      rarity: card.rarity || '',
      hp: card.hp,
      type: card.card_type,
      category: card.category,
      set: {
        name: card.set_name || '',
        id: card.set_id,
        logo: card.set_logo,
      },
      images: {
        small: card.image_url,
      },
    }));

    res.json({
      data,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page) || 1,
      pages: Math.ceil(parseInt(countResult.rows[0].count) / 20),
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/search/sets — list all sets
router.get('/sets', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT set_id, set_name, set_logo, set_symbol, set_total,
              COUNT(*) as card_count
       FROM card_index
       GROUP BY set_id, set_name, set_logo, set_symbol, set_total
       ORDER BY set_name`
    );

    const sets = result.rows.map(s => ({
      id: s.set_id,
      name: s.set_name,
      logo: s.set_logo,
      symbol: s.set_symbol,
      cardCount: { total: parseInt(s.card_count) },
    }));

    res.json({ sets });
  } catch (err) {
    console.error('Sets error:', err);
    res.status(500).json({ error: 'Failed to load sets' });
  }
});

// GET /api/search/sets/:id — get all cards in a set
router.get('/sets/:id', async (req, res) => {
  try {
    const setId = req.params.id;

    const setInfo = await pool.query(
      `SELECT DISTINCT set_name, set_logo, set_symbol, set_total
       FROM card_index WHERE set_id = $1 LIMIT 1`,
      [setId]
    );

    if (setInfo.rows.length === 0) {
      return res.status(404).json({ error: 'Set not found' });
    }

    const cards = await pool.query(
      `SELECT id, name, local_id, rarity, image_url
       FROM card_index
       WHERE set_id = $1
       ORDER BY LPAD(local_id, 5, '0')`,
      [setId]
    );

    const s = setInfo.rows[0];

    res.json({
      id: setId,
      name: s.set_name,
      logo: s.set_logo,
      symbol: s.set_symbol,
      cardCount: { total: parseInt(s.set_total) || cards.rows.length },
      cards: cards.rows.map(c => ({
        id: c.id,
        name: c.name,
        number: c.local_id,
        rarity: c.rarity,
        image: c.image_url,
      })),
    });
  } catch (err) {
    console.error('Set detail error:', err);
    res.status(500).json({ error: 'Failed to load set' });
  }
});

// GET /api/search/card/:id — get full card detail
router.get('/card/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM card_index WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }
    res.json({ card: result.rows[0] });
  } catch (err) {
    console.error('Card detail error:', err);
    res.status(500).json({ error: 'Card not found' });
  }
});

// GET /api/search/stats — index stats
router.get('/stats', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) FROM card_index');
    const sets = await pool.query('SELECT COUNT(DISTINCT set_id) FROM card_index');
    res.json({
      total_cards: parseInt(total.rows[0].count),
      total_sets: parseInt(sets.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
