const router = require('express').Router();
const pool = require('../db');
const auth = require('../middleware/auth');
const {
  convertSetIdToPokePulse,
  findCachedProducts,
  searchCatalogue,
  findMatchingCards,
  extractCardsArray,
  cacheCatalogueResults,
  getMarketData,
  extractPricingRecords,
  formatPricingData,
  savePriceHistory,
  checkRateLimit,
} = require('../lib/pricing');

// ─── Watchlist CRUD ───────────────────────────────────────────

// GET /api/watchlist — user's watchlist with latest alert info
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pw.*,
              COALESCE(json_agg(
                json_build_object(
                  'id', pa.id,
                  'alert_type', pa.alert_type,
                  'threshold', pa.threshold,
                  'is_active', pa.is_active,
                  'last_triggered', pa.last_triggered,
                  'cooldown_hours', pa.cooldown_hours
                )
              ) FILTER (WHERE pa.id IS NOT NULL), '[]') AS alerts
       FROM price_watchlist pw
       LEFT JOIN price_alerts pa ON pa.watchlist_id = pw.id
       WHERE pw.user_id = $1
       GROUP BY pw.id
       ORDER BY pw.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Watchlist fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch watchlist' });
  }
});

// POST /api/watchlist — add card to watchlist (resolves price immediately)
router.post('/', auth, async (req, res) => {
  try {
    const { set_id, card_number, card_name, set_name, image_url, product_id } = req.body;
    if (!set_id || !card_number) {
      return res.status(400).json({ error: 'set_id and card_number are required' });
    }

    let resolvedProductId = product_id || null;
    let resolvedPrice = null;

    // Try to resolve product_id and fetch initial price
    try {
      const ppSetId = convertSetIdToPokePulse(set_id);

      // Step 1: Check catalogue cache
      if (!resolvedProductId) {
        const cached = await findCachedProducts(ppSetId, card_number);
        if (cached.length > 0) {
          resolvedProductId = cached[0].product_id;
        }
      }

      // Step 2: If not cached, search catalogue API
      if (!resolvedProductId) {
        checkRateLimit();
        const catalogueData = await searchCatalogue(ppSetId, card_name || '');
        const cardsArray = extractCardsArray(catalogueData);
        if (cardsArray && cardsArray.length > 0) {
          await cacheCatalogueResults(ppSetId, cardsArray);
          const matches = findMatchingCards(cardsArray, card_number);
          if (matches.length > 0) {
            resolvedProductId = matches[0].product_id;
          }
        }
      }

      // Step 3: Fetch market price
      if (resolvedProductId) {
        checkRateLimit();
        const marketData = await getMarketData(resolvedProductId);
        const records = extractPricingRecords(marketData, resolvedProductId);
        if (records && records.length > 0) {
          const pricing = formatPricingData(records, resolvedProductId, false);
          if (pricing.marketPrice > 0) {
            resolvedPrice = pricing.marketPrice;
            await savePriceHistory(set_id, card_number, card_name, pricing);
          }
        }
      }
    } catch (priceErr) {
      // Non-fatal — card still gets added, price will be filled by cron later
      console.log(`[Watchlist] Price resolve skipped for ${set_id} #${card_number}: ${priceErr.message}`);
    }

    const result = await pool.query(
      `INSERT INTO price_watchlist (user_id, set_id, card_number, card_name, set_name, image_url, product_id, last_price, last_checked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, set_id, card_number) DO NOTHING
       RETURNING *`,
      [
        req.user.id, set_id, card_number, card_name || null, set_name || null,
        image_url || null, resolvedProductId, resolvedPrice,
        resolvedPrice ? new Date() : null
      ]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'Card already on watchlist' });
    }

    // If we resolved a product_id, update all other users watching the same card
    if (resolvedProductId || resolvedPrice) {
      await pool.query(
        `UPDATE price_watchlist SET
          product_id = COALESCE(product_id, $1),
          last_price = COALESCE($2, last_price),
          last_checked = COALESCE($3, last_checked)
         WHERE set_id = $4 AND card_number = $5 AND id != $6`,
        [resolvedProductId, resolvedPrice, resolvedPrice ? new Date() : null, set_id, card_number, result.rows[0].id]
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Watchlist add error:', err);
    res.status(500).json({ error: 'Failed to add to watchlist' });
  }
});

// DELETE /api/watchlist/:id — remove card (cascades alerts)
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM price_watchlist WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Watchlist item not found' });
    }
    res.json({ message: 'Removed from watchlist' });
  } catch (err) {
    console.error('Watchlist delete error:', err);
    res.status(500).json({ error: 'Failed to remove from watchlist' });
  }
});

// GET /api/watchlist/summary — dashboard stats
router.get('/summary', auth, async (req, res) => {
  try {
    const stats = await pool.query(
      `SELECT
        COUNT(*) AS total_cards,
        COUNT(*) FILTER (WHERE last_price IS NOT NULL) AS priced_cards,
        AVG(last_price) FILTER (WHERE last_price IS NOT NULL) AS avg_price,
        SUM(last_price) FILTER (WHERE last_price IS NOT NULL) AS total_value
       FROM price_watchlist WHERE user_id = $1`,
      [req.user.id]
    );
    const alertCount = await pool.query(
      `SELECT COUNT(*) FROM price_alerts WHERE user_id = $1 AND is_active = TRUE`,
      [req.user.id]
    );
    res.json({
      ...stats.rows[0],
      active_alerts: parseInt(alertCount.rows[0].count)
    });
  } catch (err) {
    console.error('Watchlist summary error:', err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// GET /api/watchlist/:id/history — price history from market_price_history
router.get('/:id/history', auth, async (req, res) => {
  try {
    const item = await pool.query(
      'SELECT set_id, card_number FROM price_watchlist WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (item.rows.length === 0) {
      return res.status(404).json({ error: 'Watchlist item not found' });
    }

    const { set_id, card_number } = item.rows[0];
    const days = parseInt(req.query.days) || 30;

    const history = await pool.query(
      `SELECT snapshot_date, market_price, last_sold_price, trend_7d_pct, trend_30d_pct
       FROM market_price_history
       WHERE set_id = $1 AND card_number = $2
         AND snapshot_date >= CURRENT_DATE - $3::integer
       ORDER BY snapshot_date ASC`,
      [set_id, card_number, days]
    );
    res.json(history.rows);
  } catch (err) {
    console.error('Price history error:', err);
    res.status(500).json({ error: 'Failed to fetch price history' });
  }
});

// ─── Alert CRUD ───────────────────────────────────────────────

// GET /api/watchlist/:id/alerts
router.get('/:id/alerts', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pa.* FROM price_alerts pa
       JOIN price_watchlist pw ON pw.id = pa.watchlist_id
       WHERE pa.watchlist_id = $1 AND pw.user_id = $2
       ORDER BY pa.created_at DESC`,
      [req.params.id, req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Alert fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// POST /api/watchlist/:id/alerts
router.post('/:id/alerts', auth, async (req, res) => {
  try {
    // Verify ownership
    const item = await pool.query(
      'SELECT id FROM price_watchlist WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (item.rows.length === 0) {
      return res.status(404).json({ error: 'Watchlist item not found' });
    }

    const { alert_type, threshold, cooldown_hours } = req.body;
    if (!alert_type || threshold == null) {
      return res.status(400).json({ error: 'alert_type and threshold are required' });
    }

    const validTypes = ['pct_up', 'pct_down', 'below', 'above'];
    if (!validTypes.includes(alert_type)) {
      return res.status(400).json({ error: `alert_type must be one of: ${validTypes.join(', ')}` });
    }

    const result = await pool.query(
      `INSERT INTO price_alerts (user_id, watchlist_id, alert_type, threshold, cooldown_hours)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.id, req.params.id, alert_type, threshold, cooldown_hours || 24]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Alert create error:', err);
    res.status(500).json({ error: 'Failed to create alert' });
  }
});

// PUT /api/watchlist/:id/alerts/:aid
router.put('/:id/alerts/:aid', auth, async (req, res) => {
  try {
    const { alert_type, threshold, is_active, cooldown_hours } = req.body;

    const result = await pool.query(
      `UPDATE price_alerts SET
        alert_type = COALESCE($1, alert_type),
        threshold = COALESCE($2, threshold),
        is_active = COALESCE($3, is_active),
        cooldown_hours = COALESCE($4, cooldown_hours)
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [alert_type || null, threshold ?? null, is_active ?? null, cooldown_hours || null, req.params.aid, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Alert update error:', err);
    res.status(500).json({ error: 'Failed to update alert' });
  }
});

// DELETE /api/watchlist/:id/alerts/:aid
router.delete('/:id/alerts/:aid', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM price_alerts WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.aid, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    res.json({ message: 'Alert deleted' });
  } catch (err) {
    console.error('Alert delete error:', err);
    res.status(500).json({ error: 'Failed to delete alert' });
  }
});

// ─── Notification Settings ────────────────────────────────────

// GET /api/watchlist/notifications
router.get('/notifications', auth, async (req, res) => {
  try {
    let result = await pool.query(
      'SELECT * FROM notification_settings WHERE user_id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      // Auto-create default row
      result = await pool.query(
        `INSERT INTO notification_settings (user_id) VALUES ($1) RETURNING *`,
        [req.user.id]
      );
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Notification settings fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch notification settings' });
  }
});

// PUT /api/watchlist/notifications
router.put('/notifications', auth, async (req, res) => {
  try {
    const { web_push_sub, telegram_chat_id, pushover_user_key, ntfy_topic, channels_enabled } = req.body;

    const result = await pool.query(
      `INSERT INTO notification_settings (user_id, web_push_sub, telegram_chat_id, pushover_user_key, ntfy_topic, channels_enabled, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         web_push_sub = COALESCE($2, notification_settings.web_push_sub),
         telegram_chat_id = COALESCE($3, notification_settings.telegram_chat_id),
         pushover_user_key = COALESCE($4, notification_settings.pushover_user_key),
         ntfy_topic = COALESCE($5, notification_settings.ntfy_topic),
         channels_enabled = COALESCE($6, notification_settings.channels_enabled),
         updated_at = NOW()
       RETURNING *`,
      [
        req.user.id,
        web_push_sub ? JSON.stringify(web_push_sub) : null,
        telegram_chat_id || null,
        pushover_user_key || null,
        ntfy_topic || null,
        channels_enabled ? JSON.stringify(channels_enabled) : null
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Notification settings update error:', err);
    res.status(500).json({ error: 'Failed to update notification settings' });
  }
});

module.exports = router;
