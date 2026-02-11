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

// GET /api/search/sets — list all sets with series grouping
router.get('/sets', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT set_id, set_name, set_logo, set_symbol, set_total,
              COUNT(*) as card_count,
              CASE
                WHEN set_id LIKE 'sv%' THEN 'Scarlet & Violet'
                WHEN set_id = '2021swsh' OR set_id LIKE 'swsh%' THEN 'Sword & Shield'
                WHEN set_id IN ('2018sm','2019sm') OR set_id LIKE 'sm%' THEN 'Sun & Moon'
                WHEN set_id IN ('2014xy','2015xy','2016xy') OR set_id LIKE 'xy%' THEN 'XY'
                WHEN set_id IN ('2011bw','2012bw') OR set_id LIKE 'bw%' THEN 'Black & White'
                WHEN set_id LIKE 'hgss%' THEN 'HeartGold SoulSilver'
                WHEN set_id LIKE 'pl%' THEN 'Platinum'
                WHEN set_id LIKE 'dp%' THEN 'Diamond & Pearl'
                WHEN set_id LIKE 'ex%' OR set_id = 'rs%' THEN 'EX / Ruby & Sapphire'
                WHEN set_id LIKE 'ecard%' THEN 'e-Card'
                WHEN set_id LIKE 'neo%' THEN 'Neo'
                WHEN set_id LIKE 'gym%' THEN 'Gym'
                WHEN set_id LIKE 'base%' THEN 'Base Set'
                WHEN set_id LIKE 'tk%' THEN 'Trainer Kit'
                WHEN set_id LIKE 'pop%' THEN 'POP Series'
                WHEN set_id LIKE 'me%' THEN 'Mega Evolution'
                WHEN set_id ~ '^[A-Z][0-9]' OR set_id = 'P-A' THEN 'TCG Pocket'
                WHEN set_id = 'g1' THEN 'Generations'
                WHEN set_id = 'lc' THEN 'Legendary Collection'
                WHEN set_id = 'col1' THEN 'Call of Legends'
                WHEN set_id = 'cel25' THEN 'Celebrations'
                WHEN set_id = 'det1' THEN 'Detective Pikachu'
                WHEN set_id = 'si1' THEN 'Southern Islands'
                WHEN set_id = 'dv1' THEN 'Dragon Vault'
                WHEN set_id = 'dc1' THEN 'Double Crisis'
                WHEN set_id = 'np' THEN 'Nintendo Promos'
                WHEN set_id = 'ru1' THEN 'Radiant Collection'
                WHEN set_id = 'bog' THEN 'Battle Arena Decks'
                WHEN set_id = 'fut2020' THEN 'Futsal Collection'
                ELSE 'Other'
              END as series,
              CASE
                WHEN set_id ~ '^[A-Z][0-9]' OR set_id = 'P-A' THEN 0
                WHEN set_id LIKE 'me%' THEN 0
                WHEN set_id LIKE 'sv%' THEN 1
                WHEN set_id = '2021swsh' OR set_id LIKE 'swsh%' THEN 2
                WHEN set_id IN ('2018sm','2019sm') OR set_id LIKE 'sm%' THEN 3
                WHEN set_id IN ('2014xy','2015xy','2016xy') OR set_id LIKE 'xy%' THEN 4
                WHEN set_id IN ('2011bw','2012bw') OR set_id LIKE 'bw%' THEN 5
                WHEN set_id LIKE 'hgss%' OR set_id = 'col1' THEN 6
                WHEN set_id LIKE 'pl%' THEN 7
                WHEN set_id LIKE 'dp%' THEN 8
                WHEN set_id LIKE 'ex%' THEN 9
                WHEN set_id LIKE 'ecard%' THEN 10
                WHEN set_id LIKE 'neo%' THEN 11
                WHEN set_id LIKE 'gym%' THEN 12
                WHEN set_id LIKE 'base%' THEN 13
                ELSE 20
              END as series_order
       FROM card_index
       GROUP BY set_id, set_name, set_logo, set_symbol, set_total
       ORDER BY series_order, set_name`
    );

    const sets = result.rows.map(s => ({
      id: s.set_id,
      name: s.set_name,
      logo: s.set_logo,
      symbol: s.set_symbol,
      series: s.series,
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
