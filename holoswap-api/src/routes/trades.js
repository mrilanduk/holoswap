const { Router } = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = Router();

// GET /api/trades — get user's trades
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*,
        ua.email as user_a_email, ua.display_name as user_a_name,
        ub.email as user_b_email, ub.display_name as user_b_name,
        ca.card_name as card_a_name, ca.card_set as card_a_set, ca.image_url as card_a_image,
        ca.condition as card_a_condition, ca.status as card_a_status,
        cb.card_name as card_b_name, cb.card_set as card_b_set, cb.image_url as card_b_image,
        cb.condition as card_b_condition, cb.status as card_b_status
       FROM trades t
       JOIN users ua ON t.user_a_id = ua.id
       JOIN users ub ON t.user_b_id = ub.id
       JOIN cards ca ON t.card_a_id = ca.id
       JOIN cards cb ON t.card_b_id = cb.id
       WHERE t.user_a_id = $1 OR t.user_b_id = $1
       ORDER BY t.created_at DESC`,
      [req.user.id]
    );

    res.json({ trades: result.rows });
  } catch (err) {
    console.error('Get trades error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /api/trades/find-matches — find potential matches for current user
router.get('/matches', auth, async (req, res) => {
  try {
    // Find cards where:
    // - Someone else has a card I want (their listed card matches my want list)
    // - I have a card they want (my listed card matches their want list)
    const result = await pool.query(
      `SELECT
        my_want.id as my_want_id,
        my_want.card_name as i_want_card,
        my_want.card_set as i_want_set,
        my_want.min_condition as i_want_min_condition,
        their_card.id as their_card_id,
        their_card.card_name as they_have_card,
        their_card.card_set as they_have_set,
        their_card.condition as they_have_condition,
        their_card.image_url as they_have_image,
        their_card.user_id as other_user_id,
        other_user.display_name as other_user_name,
        other_user.city as other_user_city,
        their_want.id as their_want_id,
        their_want.card_name as they_want_card,
        their_want.card_set as they_want_set,
        my_card.id as my_card_id,
        my_card.card_name as i_have_card,
        my_card.card_set as i_have_set,
        my_card.condition as i_have_condition,
        my_card.image_url as i_have_image
       FROM want_list my_want
       -- Find their card that matches my want
       JOIN cards their_card ON LOWER(their_card.card_name) = LOWER(my_want.card_name)
         AND their_card.user_id != $1
         AND their_card.status = 'listed'
       JOIN users other_user ON their_card.user_id = other_user.id
       -- Find their want that matches my card
       JOIN want_list their_want ON their_want.user_id = their_card.user_id
       JOIN cards my_card ON LOWER(my_card.card_name) = LOWER(their_want.card_name)
         AND my_card.user_id = $1
         AND my_card.status = 'listed'
       WHERE my_want.user_id = $1
       -- Exclude already traded or in-progress trades
       AND NOT EXISTS (
         SELECT 1 FROM trades
         WHERE trades.status NOT IN ('cancelled', 'rejected')
         AND (
           (trades.card_a_id = my_card.id OR trades.card_b_id = my_card.id)
           OR (trades.card_a_id = their_card.id OR trades.card_b_id = their_card.id)
         )
       )
       ORDER BY other_user.display_name, my_want.card_name
       LIMIT 50`,
      [req.user.id]
    );

    res.json({ matches: result.rows });
  } catch (err) {
    console.error('Find matches error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /api/trades — propose a trade
router.post('/', auth, async (req, res) => {
  try {
    const { my_card_id, their_card_id, other_user_id } = req.body;

    // Verify my card belongs to me and is listed
    const myCard = await pool.query(
      "SELECT * FROM cards WHERE id = $1 AND user_id = $2 AND status = 'listed'",
      [my_card_id, req.user.id]
    );
    if (myCard.rows.length === 0) {
      return res.status(400).json({ error: 'Your card is not available for trading' });
    }

    // Verify their card belongs to them and is listed
    const theirCard = await pool.query(
      "SELECT * FROM cards WHERE id = $1 AND user_id = $2 AND status = 'listed'",
      [their_card_id, other_user_id]
    );
    if (theirCard.rows.length === 0) {
      return res.status(400).json({ error: 'Their card is not available for trading' });
    }

    // Check no existing active trade for these cards
    const existing = await pool.query(
      `SELECT id FROM trades
       WHERE status NOT IN ('cancelled', 'rejected', 'complete')
       AND (card_a_id = $1 OR card_b_id = $1 OR card_a_id = $2 OR card_b_id = $2)`,
      [my_card_id, their_card_id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'One of these cards is already in an active trade' });
    }

    // Create the trade
    const result = await pool.query(
      `INSERT INTO trades (user_a_id, user_b_id, card_a_id, card_b_id, status, proposed_by)
       VALUES ($1, $2, $3, $4, 'proposed', $1)
       RETURNING *`,
      [req.user.id, other_user_id, my_card_id, their_card_id]
    );

    res.status(201).json({ trade: result.rows[0] });
  } catch (err) {
    console.error('Create trade error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/trades/:id/accept — accept a trade proposal
router.put('/:id/accept', auth, async (req, res) => {
  try {
    // Only the other user (not the proposer) can accept
    const trade = await pool.query(
      "SELECT * FROM trades WHERE id = $1 AND status = 'proposed'",
      [req.params.id]
    );
    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or already actioned' });
    }

    const t = trade.rows[0];
    if (t.proposed_by === req.user.id) {
      return res.status(400).json({ error: 'You cannot accept your own proposal' });
    }
    if (t.user_a_id !== req.user.id && t.user_b_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your trade' });
    }

    // Update trade status and card statuses
    await pool.query(
      "UPDATE trades SET status = 'accepted', user_b_accepted = TRUE, user_a_accepted = TRUE, updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );

    res.json({ message: 'Trade accepted! Both users should now ship their cards to HoloSwap.' });
  } catch (err) {
    console.error('Accept trade error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/trades/:id/decline — decline a trade
router.put('/:id/decline', auth, async (req, res) => {
  try {
    const trade = await pool.query(
      "SELECT * FROM trades WHERE id = $1 AND status = 'proposed'",
      [req.params.id]
    );
    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found' });
    }

    const t = trade.rows[0];
    if (t.user_a_id !== req.user.id && t.user_b_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your trade' });
    }

    await pool.query(
      "UPDATE trades SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );

    res.json({ message: 'Trade declined' });
  } catch (err) {
    console.error('Decline trade error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PUT /api/trades/:id/shipped — mark your card as shipped
router.put('/:id/shipped', auth, async (req, res) => {
  try {
    const { tracking_number } = req.body;

    const trade = await pool.query(
      "SELECT * FROM trades WHERE id = $1 AND status = 'accepted'",
      [req.params.id]
    );
    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or not accepted yet' });
    }

    const t = trade.rows[0];

    // Determine which card is mine
    let myCardId;
    let trackingField;
    if (t.user_a_id === req.user.id) {
      myCardId = t.card_a_id;
      trackingField = 'tracking_a';
    } else if (t.user_b_id === req.user.id) {
      myCardId = t.card_b_id;
      trackingField = 'tracking_b';
    } else {
      return res.status(403).json({ error: 'Not your trade' });
    }

    // Update card status to shipped
    await pool.query(
      "UPDATE cards SET status = 'shipped', updated_at = NOW() WHERE id = $1",
      [myCardId]
    );

    // Update trade with tracking
    await pool.query(
      `UPDATE trades SET ${trackingField} = $1, updated_at = NOW() WHERE id = $2`,
      [tracking_number || null, req.params.id]
    );

    // Check if both cards are shipped
    const cardA = await pool.query('SELECT status FROM cards WHERE id = $1', [t.card_a_id]);
    const cardB = await pool.query('SELECT status FROM cards WHERE id = $1', [t.card_b_id]);

    if (cardA.rows[0].status === 'shipped' && cardB.rows[0].status === 'shipped') {
      await pool.query(
        "UPDATE trades SET status = 'both_shipped', updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
    }

    res.json({ message: 'Card marked as shipped' });
  } catch (err) {
    console.error('Ship trade error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
