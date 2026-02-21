const cron = require('node-cron');
const pool = require('../db');
const {
  checkRateLimit,
  getMarketData,
  formatPricingData,
  extractPricingRecords,
  savePriceHistory,
  findCachedProducts,
  convertSetIdToPokePulse,
} = require('../lib/pricing');

const BATCH_SIZE = 50;

// Evaluate a single alert against old and new prices
function shouldTrigger(alert, oldPrice, newPrice) {
  if (!oldPrice || !newPrice || oldPrice === 0) return false;

  const pctChange = ((newPrice - oldPrice) / oldPrice) * 100;

  switch (alert.alert_type) {
    case 'pct_up':
      return pctChange >= parseFloat(alert.threshold);
    case 'pct_down':
      return pctChange <= -parseFloat(alert.threshold);
    case 'above':
      return newPrice >= parseFloat(alert.threshold);
    case 'below':
      return newPrice <= parseFloat(alert.threshold);
    default:
      return false;
  }
}

// Check cooldown — don't re-trigger within cooldown period
function isCooldownActive(alert) {
  if (!alert.last_triggered) return false;
  const cooldownMs = (alert.cooldown_hours || 24) * 60 * 60 * 1000;
  return Date.now() - new Date(alert.last_triggered).getTime() < cooldownMs;
}

async function runPriceMonitor() {
  console.log('[PriceMonitor] Starting price check run...');
  const startTime = Date.now();

  try {
    // Step 1: Get distinct cards to check (deduplicated across all users)
    const cards = await pool.query(
      `SELECT DISTINCT ON (set_id, card_number)
        set_id, card_number, card_name, product_id
       FROM price_watchlist
       ORDER BY set_id, card_number`
    );

    if (cards.rows.length === 0) {
      console.log('[PriceMonitor] No cards to monitor');
      return;
    }

    console.log(`[PriceMonitor] ${cards.rows.length} unique cards to check`);

    // Step 2: Resolve missing product_ids from catalogue cache
    const toResolve = cards.rows.filter(c => !c.product_id);
    for (const card of toResolve) {
      try {
        const ppSetId = convertSetIdToPokePulse(card.set_id);
        const cached = await findCachedProducts(ppSetId, card.card_number);
        if (cached.length > 0) {
          // Use first ungraded variant
          await pool.query(
            `UPDATE price_watchlist SET product_id = $1 WHERE set_id = $2 AND card_number = $3 AND product_id IS NULL`,
            [cached[0].product_id, card.set_id, card.card_number]
          );
          card.product_id = cached[0].product_id;
        }
      } catch (err) {
        console.error(`[PriceMonitor] Failed to resolve product_id for ${card.set_id} #${card.card_number}:`, err.message);
      }
    }

    // Step 3: Batch fetch market data for cards with product_ids
    const withProductId = cards.rows.filter(c => c.product_id);
    console.log(`[PriceMonitor] ${withProductId.length} cards with product IDs (${toResolve.length - withProductId.filter(c => toResolve.includes(c)).length} unresolved)`);

    let priceUpdates = 0;
    let alertsTriggered = 0;

    for (let i = 0; i < withProductId.length; i += BATCH_SIZE) {
      try {
        checkRateLimit();
      } catch (err) {
        console.log('[PriceMonitor] Rate limit reached, stopping early');
        break;
      }

      const batch = withProductId.slice(i, i + BATCH_SIZE);
      const productIds = batch.map(c => c.product_id);

      try {
        const marketData = await getMarketData(productIds);

        for (const card of batch) {
          const records = extractPricingRecords(marketData, card.product_id);
          if (!records || records.length === 0) continue;

          const pricing = formatPricingData(records, card.product_id, false);
          const newPrice = pricing.marketPrice;
          if (!newPrice || newPrice === 0) continue;

          // Get old price before updating
          const oldResult = await pool.query(
            `SELECT last_price FROM price_watchlist WHERE set_id = $1 AND card_number = $2 AND last_price IS NOT NULL LIMIT 1`,
            [card.set_id, card.card_number]
          );
          const oldPrice = oldResult.rows.length > 0 ? parseFloat(oldResult.rows[0].last_price) : null;

          // Update all watchlist entries for this card (across users)
          await pool.query(
            `UPDATE price_watchlist SET last_price = $1, last_checked = NOW() WHERE set_id = $2 AND card_number = $3`,
            [newPrice, card.set_id, card.card_number]
          );
          priceUpdates++;

          // Save to price history
          await savePriceHistory(card.set_id, card.card_number, card.card_name, pricing);

          // Step 5: Evaluate alerts for this card
          if (oldPrice) {
            const alerts = await pool.query(
              `SELECT pa.* FROM price_alerts pa
               JOIN price_watchlist pw ON pw.id = pa.watchlist_id
               WHERE pw.set_id = $1 AND pw.card_number = $2 AND pa.is_active = TRUE`,
              [card.set_id, card.card_number]
            );

            for (const alert of alerts.rows) {
              if (isCooldownActive(alert)) continue;
              if (!shouldTrigger(alert, oldPrice, newPrice)) continue;

              // Mark alert as triggered
              await pool.query(
                `UPDATE price_alerts SET last_triggered = NOW() WHERE id = $1`,
                [alert.id]
              );
              alertsTriggered++;

              // Dispatch notification (lazy-load to avoid circular deps)
              try {
                const { dispatchNotification } = require('../lib/notifications');
                const pctChange = ((newPrice - oldPrice) / oldPrice * 100).toFixed(1);
                const direction = newPrice > oldPrice ? 'up' : 'down';
                const arrow = direction === 'up' ? '📈' : '📉';

                await dispatchNotification(alert.user_id, alert.id, {
                  title: `${arrow} ${card.card_name} price ${direction}`,
                  body: `${card.card_name} (${card.set_id} #${card.card_number}) is now £${newPrice.toFixed(2)} (${direction === 'up' ? '+' : ''}${pctChange}% from £${oldPrice.toFixed(2)})`
                });
              } catch (notifErr) {
                console.error(`[PriceMonitor] Notification dispatch error:`, notifErr.message);
              }
            }
          }
        }
      } catch (err) {
        console.error(`[PriceMonitor] Batch fetch error:`, err.message);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[PriceMonitor] Done in ${duration}s — ${priceUpdates} prices updated, ${alertsTriggered} alerts triggered`);

  } catch (err) {
    console.error('[PriceMonitor] Run failed:', err);
  }
}

function startPriceMonitor() {
  // Run every 4 hours
  cron.schedule('0 */4 * * *', () => {
    runPriceMonitor();
  });

  console.log('[PriceMonitor] Scheduled — runs every 4 hours');

  // Run once on startup after a short delay (let server finish init)
  setTimeout(() => {
    runPriceMonitor();
  }, 10000);
}

module.exports = { startPriceMonitor, runPriceMonitor };
