const { Router } = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = Router();

// GET /api/trades — get user's trades (as buyer or seller)
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*,
        seller.email as seller_email, seller.display_name as seller_name,
        buyer.email as buyer_email, buyer.display_name as buyer_name,
        c.card_name, c.card_set, c.card_number, c.rarity, c.condition,
        c.image_url, c.status as card_status
       FROM trades t
       JOIN users seller ON t.seller_id = seller.id
       JOIN users buyer ON t.buyer_id = buyer.id
       JOIN cards c ON t.card_id = c.id
       WHERE t.seller_id = $1 OR t.buyer_id = $1
       ORDER BY t.created_at DESC`,
      [req.user.id]
    );

    res.json({ trades: result.rows });
  } catch (err) {
    console.error('Get trades error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /api/trades/matches — find cards that match my want list
router.get('/matches', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        w.id as want_id,
        w.card_name as wanted_card,
        w.card_set as wanted_set,
        w.min_condition,
        c.id as card_id,
        c.card_name,
        c.card_set,
        c.card_number,
        c.rarity,
        c.condition,
        c.image_url,
        c.estimated_value,
        c.user_id as seller_id,
        u.display_name as seller_name,
        u.city as seller_city
       FROM want_list w
       JOIN cards c ON LOWER(c.card_set) = LOWER(w.card_set)
         AND c.card_number = w.card_number
         AND c.user_id != $1
         AND c.status = 'listed'
       JOIN users u ON c.user_id = u.id
       WHERE w.user_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM trades
         WHERE trades.card_id = c.id
         AND trades.status NOT IN ('cancelled', 'rejected')
       )
       ORDER BY w.card_name, c.condition`,
      [req.user.id]
    );

    res.json({ matches: result.rows });
  } catch (err) {
    console.error('Find matches error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// GET /api/trades/selling — find people who want my listed cards
router.get('/selling', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        c.id as card_id,
        c.card_name,
        c.card_set,
        c.card_number,
        c.rarity,
        c.condition,
        c.image_url,
        c.estimated_value,
        w.id as want_id,
        w.user_id as buyer_id,
        w.min_condition,
        u.display_name as buyer_name,
        u.city as buyer_city
       FROM cards c
       JOIN want_list w ON LOWER(w.card_set) = LOWER(c.card_set)
         AND w.card_number = c.card_number
         AND w.user_id != $1
       JOIN users u ON w.user_id = u.id
       WHERE c.user_id = $1
       AND c.status = 'listed'
       AND NOT EXISTS (
         SELECT 1 FROM trades
         WHERE trades.card_id = c.id
         AND trades.status NOT IN ('cancelled', 'rejected')
       )
       ORDER BY c.card_name`,
      [req.user.id]
    );

    res.json({ buyers: result.rows });
  } catch (err) {
    console.error('Find buyers error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /api/trades — buyer requests a card
router.post('/', auth, async (req, res) => {
  try {
    const { card_id, seller_id } = req.body;

    if (seller_id === req.user.id) {
      return res.status(400).json({ error: "You can't buy your own card" });
    }

    // Verify card exists, is listed, belongs to seller
    const card = await pool.query(
      "SELECT * FROM cards WHERE id = $1 AND user_id = $2 AND status = 'listed'",
      [card_id, seller_id]
    );
    if (card.rows.length === 0) {
      return res.status(400).json({ error: 'Card is not available' });
    }

    // Check no existing active trade for this card
    const existing = await pool.query(
      `SELECT id FROM trades WHERE card_id = $1 AND status NOT IN ('cancelled', 'rejected')`,
      [card_id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'This card already has an active trade' });
    }

    const result = await pool.query(
      `INSERT INTO trades (seller_id, buyer_id, card_id, status)
       VALUES ($1, $2, $3, 'requested')
       RETURNING *`,
      [seller_id, req.user.id, card_id]
    );

    res.status(201).json({ trade: result.rows[0] });
  } catch (err) {
    console.error('Create trade error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/trades/:id/accept — seller accepts the request
router.put('/:id/accept', auth, async (req, res) => {
  try {
    const trade = await pool.query(
      "SELECT * FROM trades WHERE id = $1 AND status = 'requested'",
      [req.params.id]
    );
    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found' });
    }

    if (trade.rows[0].seller_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the seller can accept' });
    }

    await pool.query(
      "UPDATE trades SET status = 'accepted', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );

    res.json({ message: 'Trade accepted! Please ship the card to HoloSwap.' });
  } catch (err) {
    console.error('Accept trade error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/trades/:id/decline — either party declines
router.put('/:id/decline', auth, async (req, res) => {
  try {
    const trade = await pool.query(
      "SELECT * FROM trades WHERE id = $1 AND status IN ('requested', 'accepted')",
      [req.params.id]
    );
    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found' });
    }

    const t = trade.rows[0];
    if (t.seller_id !== req.user.id && t.buyer_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your trade' });
    }

    await pool.query(
      "UPDATE trades SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );

    res.json({ message: 'Trade cancelled' });
  } catch (err) {
    console.error('Decline trade error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/trades/:id/shipped — seller marks card as shipped
router.put('/:id/shipped', auth, async (req, res) => {
  try {
    const { tracking_number } = req.body;

    const trade = await pool.query(
      "SELECT * FROM trades WHERE id = $1 AND status = 'accepted'",
      [req.params.id]
    );
    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or not accepted' });
    }

    if (trade.rows[0].seller_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the seller can mark as shipped' });
    }

    // Update card status
    await pool.query(
      "UPDATE cards SET status = 'shipped', updated_at = NOW() WHERE id = $1",
      [trade.rows[0].card_id]
    );

    // Update trade
    await pool.query(
      "UPDATE trades SET status = 'shipped', tracking_number = $1, updated_at = NOW() WHERE id = $2",
      [tracking_number || null, req.params.id]
    );

    res.json({ message: 'Card marked as shipped' });
  } catch (err) {
    console.error('Ship trade error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
