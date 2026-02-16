const { Router } = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const {
  catalogueCache, marketDataCache, CATALOGUE_TTL, MARKET_DATA_TTL,
  getCached, setCache, checkRateLimit,
  convertSetIdToPokePulse, searchCatalogue, getMarketData,
  findMatchingCard, extractCardsArray, extractPricingRecords, formatPricingData
} = require('../lib/pricing');

const router = Router();

// Admin middleware (duplicated from admin.js to keep routes self-contained)
async function requireAdmin(req, res, next) {
  try {
    const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0 || !result.rows[0].is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
}

// IP-based rate limiting for public endpoint
const ipLookupCounts = new Map();
const IP_RATE_LIMIT = 30;
const IP_RATE_WINDOW = 60 * 60 * 1000; // 1 hour

function checkIpRateLimit(ip) {
  const now = Date.now();
  const entry = ipLookupCounts.get(ip);
  if (!entry || now - entry.start > IP_RATE_WINDOW) {
    ipLookupCounts.set(ip, { count: 1, start: now });
    return true;
  }
  if (entry.count >= IP_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// Printed set code → TCGDex set_id mapping
const SET_CODE_MAP = {
  // Scarlet & Violet era
  'SVI': 'sv01', 'PAL': 'sv02', 'OBF': 'sv03', 'MEW': 'sv03.5',
  'PAR': 'sv04', 'PAF': 'sv04.5', 'TEF': 'sv05', 'TWM': 'sv06',
  'SFA': 'sv06.5', 'SCR': 'sv07', 'SSP': 'sv08', 'PRE': 'sv08.5',
  'JTG': 'sv09', 'DRI': 'sv10', 'SVP': 'svp', 'SVE': 'sve',
  // Pokemon TCG Pocket
  'A1': 'A1', 'A1A': 'A1a', 'A2': 'A2', 'A2A': 'A2a', 'A3': 'A3',
  'P-A': 'P-A',
  // Mega evolution sets
  'MEG': 'me01', 'PFL': 'me02',
  // Sword & Shield era
  'SSH': 'swsh1', 'RCL': 'swsh2', 'DAA': 'swsh3', 'VIV': 'swsh4',
  'BST': 'swsh5', 'CRE': 'swsh6', 'EVS': 'swsh7', 'FST': 'swsh8',
  'BRS': 'swsh9', 'ASR': 'swsh10', 'LOR': 'swsh11', 'SIT': 'swsh12',
  'CRZ': 'swsh12.5',
  // Sun & Moon era
  'SUM': 'sm1', 'GRI': 'sm2', 'BUS': 'sm3', 'SLG': 'sm35',
  'CIN': 'sm4', 'UPR': 'sm5', 'FLI': 'sm6', 'CES': 'sm7',
  'LOT': 'sm8', 'TEU': 'sm9', 'UNB': 'sm10', 'UNM': 'sm11',
  'CEC': 'sm12',
  // XY era
  'XY': 'xy1', 'FLF': 'xy2', 'FFI': 'xy3', 'PHF': 'xy4',
  'PRC': 'xy5', 'ROS': 'xy6', 'AOR': 'xy7', 'BKT': 'xy8',
  'BKP': 'xy9', 'FCO': 'xy10', 'STS': 'xy11', 'EVO': 'xy12',
  // Base sets
  'BS': 'base1', 'JU': 'base2', 'FO': 'base3', 'BS2': 'base4',
  'TR': 'base5', 'GY': 'base6',
};

// Parse customer input
function parseCardInput(input) {
  const trimmed = input.trim();

  // Pattern: "MEG 089/123" or "SVI 199/258"
  const setNumberTotal = trimmed.match(/^([A-Za-z0-9._-]+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (setNumberTotal) {
    return {
      type: 'set_number',
      setCode: setNumberTotal[1].toUpperCase(),
      cardNumber: setNumberTotal[2].replace(/^0+/, '') || '0',
    };
  }

  // Pattern: "MEG 089"
  const setNum = trimmed.match(/^([A-Za-z0-9._-]+)\s+(\d+)$/);
  if (setNum) {
    return {
      type: 'set_number',
      setCode: setNum[1].toUpperCase(),
      cardNumber: setNum[2].replace(/^0+/, '') || '0',
    };
  }

  // Pattern: "089/123" (number only)
  const numOnly = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (numOnly) {
    return {
      type: 'number_only',
      cardNumber: numOnly[1].replace(/^0+/, '') || '0',
      total: numOnly[2],
    };
  }

  // Fallback: name search
  return {
    type: 'name_search',
    query: trimmed,
  };
}

// Resolve set code to TCGDex set_id
async function resolveSetCode(setCode) {
  // Check hardcoded map
  if (SET_CODE_MAP[setCode]) return SET_CODE_MAP[setCode];

  // Try as direct set_id
  const directMatch = await pool.query(
    'SELECT DISTINCT set_id FROM card_index WHERE LOWER(set_id) = $1 LIMIT 1',
    [setCode.toLowerCase()]
  );
  if (directMatch.rows.length > 0) return directMatch.rows[0].set_id;

  // Fuzzy match on set_name
  const nameMatch = await pool.query(
    'SELECT DISTINCT set_id FROM card_index WHERE UPPER(set_name) LIKE $1 LIMIT 1',
    [`%${setCode}%`]
  );
  if (nameMatch.rows.length > 0) return nameMatch.rows[0].set_id;

  return null;
}

// Look up card in card_index by set and number
async function findCardInIndex(setId, cardNumber) {
  // Try exact local_id match
  const exact = await pool.query(
    'SELECT * FROM card_index WHERE set_id = $1 AND local_id = $2 LIMIT 1',
    [setId, cardNumber]
  );
  if (exact.rows.length > 0) return exact.rows[0];

  // Try with leading zeros stripped/added
  const padded = cardNumber.padStart(3, '0');
  const alt = await pool.query(
    'SELECT * FROM card_index WHERE set_id = $1 AND (local_id = $2 OR local_id = $3) LIMIT 1',
    [setId, padded, String(parseInt(cardNumber, 10))]
  );
  if (alt.rows.length > 0) return alt.rows[0];

  return null;
}

// Search card_index by name
async function searchCardsByName(query) {
  const result = await pool.query(
    `SELECT * FROM card_index WHERE LOWER(name) LIKE $1 ORDER BY set_id, local_id LIMIT 20`,
    [`%${query.toLowerCase()}%`]
  );
  return result.rows;
}

// Get pricing for a card
async function getCardPricing(setId, cardNumber, cardName) {
  const pokePulseSetId = convertSetIdToPokePulse(setId);
  console.log(`[Vending] Converting setId: ${setId} → ${pokePulseSetId}`);

  // Try set IDs in order: converted, original TCGDex, then no set filter
  const setIdsToTry = [pokePulseSetId];
  if (setId !== pokePulseSetId) setIdsToTry.push(setId);
  setIdsToTry.push(null); // fallback: name-only search

  let cardsArray = null;
  let catalogueData = null;

  for (const trySetId of setIdsToTry) {
    const catalogueCacheKey = `catalogue:${trySetId || 'noset'}:${cardName}`;
    catalogueData = getCached(catalogueCache, catalogueCacheKey, CATALOGUE_TTL);

    if (!catalogueData) {
      checkRateLimit();
      console.log(`[Vending] Catalogue search: setId=${trySetId || 'NONE'}, cardName=${cardName}`);
      catalogueData = await searchCatalogue(trySetId, cardName);
      setCache(catalogueCache, catalogueCacheKey, catalogueData);
    }

    cardsArray = extractCardsArray(catalogueData);
    console.log(`[Vending] setId=${trySetId || 'NONE'} → ${cardsArray ? cardsArray.length : 0} cards`);
    if (cardsArray && cardsArray.length > 0) break;
  }

  if (!cardsArray || cardsArray.length === 0) return null;

  const matchingCard = findMatchingCard(cardsArray, cardNumber);
  if (!matchingCard) return null;

  const productId = matchingCard.product_id;
  console.log(`[Vending] Found product_id: ${productId}`);

  // Market data lookup
  const marketCacheKey = `market:${productId}`;
  let marketData = getCached(marketDataCache, marketCacheKey, MARKET_DATA_TTL);
  let cached = true;

  if (!marketData) {
    checkRateLimit();
    marketData = await getMarketData(productId);
    setCache(marketDataCache, marketCacheKey, marketData);
    cached = false;
  }

  const pricingRecords = extractPricingRecords(marketData, productId);
  if (!pricingRecords || pricingRecords.length === 0) return null;

  return formatPricingData(pricingRecords, productId, cached);
}

// ============================================================
// PUBLIC: POST /api/vending/lookup
// Customer submits card input, gets price back
// ============================================================
router.post('/lookup', async (req, res) => {
  try {
    const { input } = req.body;
    if (!input || !input.trim()) {
      return res.status(400).json({ error: 'Please enter a card ID or name' });
    }

    if (!checkIpRateLimit(req.ip)) {
      return res.status(429).json({ error: 'Too many lookups. Please wait a moment.' });
    }

    const parsed = parseCardInput(input);
    console.log(`[Vending] Input: "${input}" → parsed:`, parsed);

    // Name search mode
    if (parsed.type === 'name_search') {
      const cards = await searchCardsByName(parsed.query);
      if (cards.length === 0) {
        return res.json({ success: true, results: [], message: 'No cards found' });
      }
      return res.json({
        success: true,
        results: cards.map(c => ({
          name: c.name,
          set_id: c.set_id,
          set_name: c.set_name,
          local_id: c.local_id,
          image_url: c.image_url,
          rarity: c.rarity,
        }))
      });
    }

    // Number-only mode (no set code)
    if (parsed.type === 'number_only') {
      return res.json({
        success: true,
        results: [],
        message: 'Please include a set code (e.g. SVI 089/123)'
      });
    }

    // Set + number mode
    const setId = await resolveSetCode(parsed.setCode);
    if (!setId) {
      return res.json({
        success: true,
        results: [],
        message: `Unknown set code "${parsed.setCode}". Try searching by card name instead.`
      });
    }

    const card = await findCardInIndex(setId, parsed.cardNumber);
    if (!card) {
      return res.json({
        success: true,
        lookup: null,
        message: `Card #${parsed.cardNumber} not found in set ${parsed.setCode}`
      });
    }

    // Get pricing
    let pricingData = null;
    try {
      pricingData = await getCardPricing(setId, parsed.cardNumber, card.name);
    } catch (pricingErr) {
      console.error('[Vending] Pricing error:', pricingErr.message);
    }

    // Save lookup to database
    const insertResult = await pool.query(
      `INSERT INTO vending_lookups (raw_input, set_code, card_number, card_name, set_name, set_id, image_url, market_price, currency, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        input.trim(),
        parsed.setCode,
        parsed.cardNumber,
        card.name,
        card.set_name,
        setId,
        card.image_url,
        pricingData?.marketPrice || null,
        pricingData?.currency || 'GBP',
        req.ip
      ]
    );

    res.json({
      success: true,
      lookup: {
        id: insertResult.rows[0].id,
        card_name: card.name,
        set_name: card.set_name,
        set_id: setId,
        card_number: parsed.cardNumber,
        image_url: card.image_url,
        rarity: card.rarity,
        market_price: pricingData?.marketPrice || null,
        currency: pricingData?.currency || 'GBP',
        conditions: pricingData?.conditions || null,
        trends: pricingData?.trends || null,
      }
    });

  } catch (err) {
    console.error('[Vending] Lookup error:', err);
    if (err.status === 429) {
      return res.status(429).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to look up card' });
  }
});

// PUBLIC: POST /api/vending/lookup-card
// Called when customer picks a card from name search results
router.post('/lookup-card', async (req, res) => {
  try {
    const { name, set_id, local_id } = req.body;
    if (!name || !set_id || !local_id) {
      return res.status(400).json({ error: 'Missing card details' });
    }

    if (!checkIpRateLimit(req.ip)) {
      return res.status(429).json({ error: 'Too many lookups. Please wait a moment.' });
    }

    const card = await findCardInIndex(set_id, local_id);
    if (!card) {
      return res.json({ success: true, lookup: null, message: 'Card not found' });
    }

    let pricingData = null;
    try {
      pricingData = await getCardPricing(set_id, local_id, name);
    } catch (pricingErr) {
      console.error('[Vending] Pricing error:', pricingErr.message);
    }

    // Save lookup
    const insertResult = await pool.query(
      `INSERT INTO vending_lookups (raw_input, set_code, card_number, card_name, set_name, set_id, image_url, market_price, currency, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        `${name} (${set_id} #${local_id})`,
        set_id,
        local_id,
        name,
        card.set_name,
        set_id,
        card.image_url,
        pricingData?.marketPrice || null,
        pricingData?.currency || 'GBP',
        req.ip
      ]
    );

    res.json({
      success: true,
      lookup: {
        id: insertResult.rows[0].id,
        card_name: name,
        set_name: card.set_name,
        set_id,
        card_number: local_id,
        image_url: card.image_url,
        rarity: card.rarity,
        market_price: pricingData?.marketPrice || null,
        currency: pricingData?.currency || 'GBP',
        conditions: pricingData?.conditions || null,
        trends: pricingData?.trends || null,
      }
    });

  } catch (err) {
    console.error('[Vending] Lookup-card error:', err);
    res.status(500).json({ error: 'Failed to look up card' });
  }
});

// ============================================================
// ADMIN: GET /api/vending/queue
// ============================================================
router.get('/queue', auth, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const result = await pool.query(
      `SELECT * FROM vending_lookups WHERE status = $1 AND COALESCE(type, 'sell') = 'sell' ORDER BY created_at DESC LIMIT 50`,
      [status]
    );
    res.json({ lookups: result.rows });
  } catch (err) {
    console.error('[Vending] Queue error:', err);
    res.status(500).json({ error: 'Failed to load queue' });
  }
});

// ADMIN: PUT /api/vending/queue/:id/complete
router.put('/queue/:id/complete', auth, requireAdmin, async (req, res) => {
  try {
    const { sale_price, sale_notes } = req.body;
    const result = await pool.query(
      `UPDATE vending_lookups SET
        status = 'completed',
        sale_price = $1,
        sale_notes = $2,
        completed_by = $3,
        completed_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [sale_price || null, sale_notes || null, req.user.id, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lookup not found' });
    res.json({ lookup: result.rows[0] });
  } catch (err) {
    console.error('[Vending] Complete error:', err);
    res.status(500).json({ error: 'Failed to complete sale' });
  }
});

// ADMIN: PUT /api/vending/queue/:id/skip
router.put('/queue/:id/skip', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE vending_lookups SET status = 'skipped', completed_by = $1, completed_at = NOW()
       WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lookup not found' });
    res.json({ lookup: result.rows[0] });
  } catch (err) {
    console.error('[Vending] Skip error:', err);
    res.status(500).json({ error: 'Failed to skip lookup' });
  }
});

// ADMIN: GET /api/vending/sales
router.get('/sales', auth, requireAdmin, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const result = await pool.query(
      `SELECT vl.*, u.display_name as completed_by_name
       FROM vending_lookups vl
       LEFT JOIN users u ON vl.completed_by = u.id
       WHERE vl.status = 'completed'
         AND COALESCE(vl.type, 'sell') = 'sell'
         AND vl.completed_at::date = $1
       ORDER BY vl.completed_at DESC`,
      [date]
    );

    const totalResult = await pool.query(
      `SELECT COALESCE(SUM(sale_price), 0) as total_sales, COUNT(*) as sale_count
       FROM vending_lookups
       WHERE status = 'completed' AND COALESCE(type, 'sell') = 'sell' AND completed_at::date = $1`,
      [date]
    );

    res.json({
      sales: result.rows,
      total_sales: parseFloat(totalResult.rows[0].total_sales),
      sale_count: parseInt(totalResult.rows[0].sale_count),
    });
  } catch (err) {
    console.error('[Vending] Sales error:', err);
    res.status(500).json({ error: 'Failed to load sales' });
  }
});

// ============================================================
// ADMIN: POST /api/vending/buy-lookup
// Admin looks up a card for buying from a customer
// ============================================================
router.post('/buy-lookup', auth, requireAdmin, async (req, res) => {
  try {
    const { input } = req.body;
    if (!input || !input.trim()) {
      return res.status(400).json({ error: 'Please enter a card ID or name' });
    }

    const parsed = parseCardInput(input);
    console.log(`[Vending Buy] Input: "${input}" → parsed:`, parsed);

    // Name search mode
    if (parsed.type === 'name_search') {
      const cards = await searchCardsByName(parsed.query);
      if (cards.length === 0) {
        return res.json({ success: true, results: [], message: 'No cards found' });
      }
      return res.json({
        success: true,
        results: cards.map(c => ({
          name: c.name,
          set_id: c.set_id,
          set_name: c.set_name,
          local_id: c.local_id,
          image_url: c.image_url,
          rarity: c.rarity,
        }))
      });
    }

    if (parsed.type === 'number_only') {
      return res.json({
        success: true,
        results: [],
        message: 'Please include a set code (e.g. SVI 089/123)'
      });
    }

    const setId = await resolveSetCode(parsed.setCode);
    if (!setId) {
      return res.json({
        success: true,
        results: [],
        message: `Unknown set code "${parsed.setCode}". Try searching by card name instead.`
      });
    }

    const card = await findCardInIndex(setId, parsed.cardNumber);
    if (!card) {
      return res.json({
        success: true,
        lookup: null,
        message: `Card #${parsed.cardNumber} not found in set ${parsed.setCode}`
      });
    }

    let pricingData = null;
    try {
      pricingData = await getCardPricing(setId, parsed.cardNumber, card.name);
    } catch (pricingErr) {
      console.error('[Vending Buy] Pricing error:', pricingErr.message);
    }

    // Save as buy lookup
    const insertResult = await pool.query(
      `INSERT INTO vending_lookups (raw_input, set_code, card_number, card_name, set_name, set_id, image_url, market_price, currency, ip_address, type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'buy')
       RETURNING id`,
      [
        input.trim(),
        parsed.setCode,
        parsed.cardNumber,
        card.name,
        card.set_name,
        setId,
        card.image_url,
        pricingData?.marketPrice || null,
        pricingData?.currency || 'GBP',
        req.ip
      ]
    );

    res.json({
      success: true,
      lookup: {
        id: insertResult.rows[0].id,
        card_name: card.name,
        set_name: card.set_name,
        set_id: setId,
        card_number: parsed.cardNumber,
        image_url: card.image_url,
        rarity: card.rarity,
        market_price: pricingData?.marketPrice || null,
        currency: pricingData?.currency || 'GBP',
      }
    });

  } catch (err) {
    console.error('[Vending Buy] Lookup error:', err);
    if (err.status === 429) {
      return res.status(429).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to look up card' });
  }
});

// ADMIN: POST /api/vending/buy-lookup-card
// Admin picks a card from name search results for buying
router.post('/buy-lookup-card', auth, requireAdmin, async (req, res) => {
  try {
    const { name, set_id, local_id } = req.body;
    if (!name || !set_id || !local_id) {
      return res.status(400).json({ error: 'Missing card details' });
    }

    const card = await findCardInIndex(set_id, local_id);
    if (!card) {
      return res.json({ success: true, lookup: null, message: 'Card not found' });
    }

    let pricingData = null;
    try {
      pricingData = await getCardPricing(set_id, local_id, name);
    } catch (pricingErr) {
      console.error('[Vending Buy] Pricing error:', pricingErr.message);
    }

    const insertResult = await pool.query(
      `INSERT INTO vending_lookups (raw_input, set_code, card_number, card_name, set_name, set_id, image_url, market_price, currency, ip_address, type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'buy')
       RETURNING id`,
      [
        `${name} (${set_id} #${local_id})`,
        set_id,
        local_id,
        name,
        card.set_name,
        set_id,
        card.image_url,
        pricingData?.marketPrice || null,
        pricingData?.currency || 'GBP',
        req.ip
      ]
    );

    res.json({
      success: true,
      lookup: {
        id: insertResult.rows[0].id,
        card_name: name,
        set_name: card.set_name,
        set_id,
        card_number: local_id,
        image_url: card.image_url,
        rarity: card.rarity,
        market_price: pricingData?.marketPrice || null,
        currency: pricingData?.currency || 'GBP',
      }
    });

  } catch (err) {
    console.error('[Vending Buy] Lookup-card error:', err);
    res.status(500).json({ error: 'Failed to look up card' });
  }
});

// ADMIN: GET /api/vending/buys
router.get('/buys', auth, requireAdmin, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const result = await pool.query(
      `SELECT vl.*, u.display_name as completed_by_name
       FROM vending_lookups vl
       LEFT JOIN users u ON vl.completed_by = u.id
       WHERE vl.status = 'completed'
         AND COALESCE(vl.type, 'sell') = 'buy'
         AND vl.completed_at::date = $1
       ORDER BY vl.completed_at DESC`,
      [date]
    );

    const totalResult = await pool.query(
      `SELECT COALESCE(SUM(sale_price), 0) as total_buys, COUNT(*) as buy_count
       FROM vending_lookups
       WHERE status = 'completed' AND COALESCE(type, 'sell') = 'buy' AND completed_at::date = $1`,
      [date]
    );

    res.json({
      buys: result.rows,
      total_buys: parseFloat(totalResult.rows[0].total_buys),
      buy_count: parseInt(totalResult.rows[0].buy_count),
    });
  } catch (err) {
    console.error('[Vending] Buys error:', err);
    res.status(500).json({ error: 'Failed to load buys' });
  }
});

// ADMIN: Commit day summary
router.post('/commit-day', auth, requireAdmin, async (req, res) => {
  try {
    const date = req.body.date || new Date().toISOString().split('T')[0];
    const notes = req.body.notes || null;

    const sellResult = await pool.query(
      `SELECT COALESCE(SUM(sale_price), 0) as total_sold, COUNT(*) as cards_sold
       FROM vending_lookups
       WHERE status = 'completed' AND COALESCE(type, 'sell') = 'sell' AND completed_at::date = $1`,
      [date]
    );
    const buyResult = await pool.query(
      `SELECT COALESCE(SUM(sale_price), 0) as total_bought, COUNT(*) as cards_bought
       FROM vending_lookups
       WHERE status = 'completed' AND COALESCE(type, 'sell') = 'buy' AND completed_at::date = $1`,
      [date]
    );

    const totalSold = parseFloat(sellResult.rows[0].total_sold);
    const cardsSold = parseInt(sellResult.rows[0].cards_sold);
    const totalBought = parseFloat(buyResult.rows[0].total_bought);
    const cardsBought = parseInt(buyResult.rows[0].cards_bought);
    const netProfit = totalSold - totalBought;

    const result = await pool.query(
      `INSERT INTO vending_daily_summaries (summary_date, total_sold, cards_sold, total_bought, cards_bought, net_profit, notes, committed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (summary_date) DO UPDATE SET
         total_sold = EXCLUDED.total_sold,
         cards_sold = EXCLUDED.cards_sold,
         total_bought = EXCLUDED.total_bought,
         cards_bought = EXCLUDED.cards_bought,
         net_profit = EXCLUDED.net_profit,
         notes = COALESCE(EXCLUDED.notes, vending_daily_summaries.notes),
         committed_by = EXCLUDED.committed_by,
         created_at = NOW()
       RETURNING *`,
      [date, totalSold, cardsSold, totalBought, cardsBought, netProfit, notes, req.user.id]
    );

    res.json({ summary: result.rows[0] });
  } catch (err) {
    console.error('[Vending] Commit day error:', err);
    res.status(500).json({ error: 'Failed to commit day' });
  }
});

// ADMIN: Check if day is committed
router.get('/commit-day/check', auth, requireAdmin, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const result = await pool.query(
      'SELECT * FROM vending_daily_summaries WHERE summary_date = $1',
      [date]
    );
    res.json({
      committed: result.rows.length > 0,
      summary: result.rows[0] || null,
    });
  } catch (err) {
    console.error('[Vending] Check commit error:', err);
    res.status(500).json({ error: 'Failed to check commit status' });
  }
});

// ADMIN: Get committed day history
router.get('/commit-day/history', auth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT vds.*, u.display_name as committed_by_name
       FROM vending_daily_summaries vds
       LEFT JOIN users u ON vds.committed_by = u.id
       ORDER BY vds.summary_date DESC
       LIMIT 90`
    );
    res.json({ summaries: result.rows });
  } catch (err) {
    console.error('[Vending] History error:', err);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

module.exports = router;
