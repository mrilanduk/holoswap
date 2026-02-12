const { Router } = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = Router();

// HoloSwap escrow address
const ESCROW_ADDRESS = {
  name: 'HoloSwap Authentication Centre',
  line1: '123 Example Street',
  line2: '',
  city: 'London',
  county: '',
  postcode: 'SW1A 1AA',
  country: 'United Kingdom',
};

// GET /api/trades — get user's trades
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.seller_id, t.buyer_id, t.card_id, t.status, t.tracking_number,
        t.outbound_tracking, t.price, t.holoswap_fee, t.payment_status, t.notes,
        t.created_at, t.updated_at,
        seller.display_name as seller_name,
        buyer.display_name as buyer_name,
        c.card_name, c.card_set, c.card_number, c.rarity, c.condition,
        c.image_url, c.status as card_status, c.estimated_value
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

// GET /api/trades/escrow-address — get HoloSwap shipping address
router.get('/escrow-address', auth, async (req, res) => {
  res.json({ address: ESCROW_ADDRESS });
});

// POST /api/trades — buyer requests a card (broadcasts to all matching sellers)
router.post('/', auth, async (req, res) => {
  try {
    const { card_id, seller_id, card_set, card_number, condition } = req.body;

    // Check buyer has a delivery address
    const buyer = await pool.query(
      'SELECT address_line1, address_line2, city, county, postcode, country FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!buyer.rows[0].address_line1 || !buyer.rows[0].city || !buyer.rows[0].postcode) {
      return res.status(400).json({ error: 'Please add a delivery address in your profile before requesting a trade' });
    }

    const b = buyer.rows[0];
    const buyerAddress = [b.address_line1, b.address_line2, b.city, b.county, b.postcode, b.country]
      .filter(Boolean).join(', ');

    // Broadcast mode: send request to ALL sellers with matching card+condition
    if (card_set && card_number && condition) {
      const cards = await pool.query(
        `SELECT c.id, c.user_id, c.estimated_value FROM cards c
         WHERE c.card_set = $1 AND c.card_number = $2 AND c.condition = $3
         AND c.status = 'listed' AND c.user_id != $4
         ORDER BY c.created_at ASC`,
        [card_set, card_number, condition, req.user.id]
      );

      if (cards.rows.length === 0) {
        return res.status(400).json({ error: 'No available cards match this request' });
      }

      // Check buyer doesn't already have active requests for this card+condition
      const existingBuyer = await pool.query(
        `SELECT t.id FROM trades t
         JOIN cards c ON t.card_id = c.id
         WHERE t.buyer_id = $1 AND c.card_set = $2 AND c.card_number = $3
         AND c.condition = $4 AND t.status NOT IN ('cancelled', 'rejected')`,
        [req.user.id, card_set, card_number, condition]
      );
      if (existingBuyer.rows.length > 0) {
        return res.status(400).json({ error: 'You already have an active request for this card' });
      }

      // Create a trade request for EACH available seller
      const createdTrades = [];
      for (const card of cards.rows) {
        const existingCard = await pool.query(
          `SELECT id FROM trades WHERE card_id = $1 AND status NOT IN ('cancelled', 'rejected')`,
          [card.id]
        );
        if (existingCard.rows.length > 0) continue;

        const result = await pool.query(
          `INSERT INTO trades (seller_id, buyer_id, card_id, status, buyer_address, price)
           VALUES ($1, $2, $3, 'requested', $4, $5)
           RETURNING *`,
          [card.user_id, req.user.id, card.id, buyerAddress, card.estimated_value || null]
        );
        createdTrades.push(result.rows[0]);
      }

      if (createdTrades.length === 0) {
        return res.status(400).json({ error: 'All matching cards already have active trades' });
      }

      return res.status(201).json({
        message: `Request sent to ${createdTrades.length} seller${createdTrades.length > 1 ? 's' : ''}! First to accept wins.`,
        trades: createdTrades,
        count: createdTrades.length,
      });
    }

    // Fallback: single card request (legacy)
    if (!card_id || !seller_id) {
      return res.status(400).json({ error: 'Missing card details' });
    }
    if (seller_id === req.user.id) {
      return res.status(400).json({ error: "You can't buy your own card" });
    }

    const card = await pool.query(
      "SELECT * FROM cards WHERE id = $1 AND user_id = $2 AND status = 'listed'",
      [card_id, seller_id]
    );
    if (card.rows.length === 0) {
      return res.status(400).json({ error: 'Card is not available' });
    }

    const existing = await pool.query(
      `SELECT id FROM trades WHERE card_id = $1 AND status NOT IN ('cancelled', 'rejected')`,
      [card_id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'This card already has an active trade' });
    }

    const result = await pool.query(
      `INSERT INTO trades (seller_id, buyer_id, card_id, status, buyer_address, price)
       VALUES ($1, $2, $3, 'requested', $4, $5)
       RETURNING *`,
      [seller_id, req.user.id, card_id, buyerAddress, card.rows[0].estimated_value || null]
    );

    res.status(201).json({ trade: result.rows[0] });
  } catch (err) {
    console.error('Create trade error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/trades/:id/accept — seller accepts the request (first to accept wins)
router.put('/:id/accept', auth, async (req, res) => {
  try {
    const trade = await pool.query(
      `SELECT t.*, c.card_set, c.card_number, c.condition
       FROM trades t JOIN cards c ON t.card_id = c.id
       WHERE t.id = $1 AND t.status = 'requested'`,
      [req.params.id]
    );
    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or already accepted' });
    }

    if (trade.rows[0].seller_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the seller can accept' });
    }

    const t = trade.rows[0];

    // Accept this trade
    await pool.query(
      "UPDATE trades SET status = 'accepted', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );

    // Cancel all other 'requested' trades from the same buyer for the same card+condition
    const cancelled = await pool.query(
      `UPDATE trades SET status = 'cancelled', notes = 'Auto-cancelled: another seller accepted first', updated_at = NOW()
       WHERE buyer_id = $1 AND id != $2 AND status = 'requested'
       AND card_id IN (
         SELECT c.id FROM cards c
         WHERE c.card_set = $3 AND c.card_number = $4 AND c.condition = $5
       )
       RETURNING id`,
      [t.buyer_id, req.params.id, t.card_set, t.card_number, t.condition]
    );

    res.json({
      message: `Trade accepted! ${cancelled.rows.length > 0 ? `${cancelled.rows.length} other offer${cancelled.rows.length > 1 ? 's' : ''} cancelled.` : ''} Please ship the card to HoloSwap for authentication.`,
      escrowAddress: ESCROW_ADDRESS,
      cancelledCount: cancelled.rows.length,
    });
  } catch (err) {
    console.error('Accept trade error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/trades/:id/decline — either party cancels
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

    // Reset card status back to listed
    await pool.query(
      "UPDATE cards SET status = 'listed', updated_at = NOW() WHERE id = $1",
      [t.card_id]
    );

    res.json({ message: 'Trade cancelled' });
  } catch (err) {
    console.error('Decline trade error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/trades/:id/shipped — seller marks card as shipped to HoloSwap
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

    await pool.query(
      "UPDATE cards SET status = 'shipped', updated_at = NOW() WHERE id = $1",
      [trade.rows[0].card_id]
    );

    await pool.query(
      "UPDATE trades SET status = 'shipped', tracking_number = $1, updated_at = NOW() WHERE id = $2",
      [tracking_number || null, req.params.id]
    );

    res.json({ message: 'Card marked as shipped to HoloSwap' });
  } catch (err) {
    console.error('Ship trade error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
