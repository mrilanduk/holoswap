const { Router } = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const {
  catalogueCache, marketDataCache, CATALOGUE_TTL, MARKET_DATA_TTL,
  getCached, setCache, checkRateLimit,
  convertSetIdToPokePulse, searchCatalogue, getMarketData,
  findMatchingCard, extractCardsArray, extractPricingRecords, formatPricingData,
  analyzeBuyRecommendation
} = require('../lib/pricing');

const router = Router();

// Vendor/Admin middleware — allows both vendors and admins to access vending routes
async function requireVendorOrAdmin(req, res, next) {
  try {
    const result = await pool.query('SELECT is_admin, is_vendor FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user || (!user.is_admin && !user.is_vendor)) {
      return res.status(403).json({ error: 'Vending access required' });
    }
    req.isAdmin = user.is_admin;
    req.isVendor = user.is_vendor;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
}

// Helper: build vendor filter for queries
// Admin sees only untagged (their own) lookups; vendors see only their own
// paramStart = the next available $N in the query, alias = optional table alias (e.g. 'vl')
function vendorFilter(req, paramStart, alias) {
  const col = alias ? `${alias}.vendor_id` : 'vendor_id';
  if (req.isAdmin) return { clause: `AND ${col} IS NULL`, params: [], nextParam: paramStart };
  return {
    clause: `AND ${col} = $${paramStart}`,
    params: [req.user.id],
    nextParam: paramStart + 1,
  };
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
    const { input, vendor_code } = req.body;
    if (!input || !input.trim()) {
      return res.status(400).json({ error: 'Please enter a card ID or name' });
    }

    if (!checkIpRateLimit(req.ip)) {
      return res.status(429).json({ error: 'Too many lookups. Please wait a moment.' });
    }

    // Resolve vendor
    let vendorId = null;
    if (vendor_code) {
      const vr = await pool.query('SELECT id FROM users WHERE UPPER(vendor_code) = UPPER($1) AND is_vendor = true', [vendor_code]);
      if (vr.rows.length > 0) vendorId = vr.rows[0].id;
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
      `INSERT INTO vending_lookups (raw_input, set_code, card_number, card_name, set_name, set_id, image_url, market_price, currency, ip_address, vendor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
        req.ip,
        vendorId
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
    const { name, set_id, local_id, vendor_code } = req.body;
    if (!name || !set_id || !local_id) {
      return res.status(400).json({ error: 'Missing card details' });
    }

    if (!checkIpRateLimit(req.ip)) {
      return res.status(429).json({ error: 'Too many lookups. Please wait a moment.' });
    }

    // Resolve vendor
    let vendorId = null;
    if (vendor_code) {
      const vr = await pool.query('SELECT id FROM users WHERE UPPER(vendor_code) = UPPER($1) AND is_vendor = true', [vendor_code]);
      if (vr.rows.length > 0) vendorId = vr.rows[0].id;
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
      `INSERT INTO vending_lookups (raw_input, set_code, card_number, card_name, set_name, set_id, image_url, market_price, currency, ip_address, vendor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
        req.ip,
        vendorId
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

// PUBLIC: POST /api/vending/submit-basket
// Groups lookup IDs under a shared basket_id
router.post('/submit-basket', async (req, res) => {
  try {
    const { lookup_ids } = req.body;
    if (!lookup_ids || !Array.isArray(lookup_ids) || lookup_ids.length === 0) {
      return res.status(400).json({ error: 'No items to submit' });
    }

    const basketId = `basket_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const intIds = lookup_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    const result = await pool.query(
      `UPDATE vending_lookups SET basket_id = $1 WHERE id = ANY($2::int[]) AND status = 'pending'`,
      [basketId, intIds]
    );

    console.log(`[Vending] Submit basket: ${intIds.length} IDs sent, ${result.rowCount} rows updated, basket_id=${basketId}`);
    res.json({ success: true, basket_id: basketId, count: result.rowCount });
  } catch (err) {
    console.error('[Vending] Submit basket error:', err);
    res.status(500).json({ error: 'Failed to submit basket' });
  }
});

// PUBLIC: GET /api/vending/vendor/:code
// Returns vendor display name for price checker header
router.get('/vendor/:code', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT display_name, vendor_code FROM users WHERE UPPER(vendor_code) = UPPER($1) AND is_vendor = true',
      [req.params.code]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    res.json({ vendor: result.rows[0] });
  } catch (err) {
    console.error('[Vending] Vendor info error:', err);
    res.status(500).json({ error: 'Failed to load vendor info' });
  }
});

// ============================================================
// ADMIN: GET /api/vending/queue
// ============================================================
router.get('/queue', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const vf = vendorFilter(req, 2);
    const result = await pool.query(
      `SELECT * FROM vending_lookups WHERE status = $1 AND COALESCE(type, 'sell') = 'sell' ${vf.clause} ORDER BY created_at DESC LIMIT 50`,
      [status, ...vf.params]
    );
    res.json({ lookups: result.rows });
  } catch (err) {
    console.error('[Vending] Queue error:', err);
    res.status(500).json({ error: 'Failed to load queue' });
  }
});

// ADMIN: PUT /api/vending/queue/:id/complete
router.put('/queue/:id/complete', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    const { sale_price, sale_notes, payment_method } = req.body;
    const vf = vendorFilter(req, 6);
    const result = await pool.query(
      `UPDATE vending_lookups SET
        status = 'completed',
        sale_price = $1,
        sale_notes = $2,
        payment_method = $3,
        completed_by = $4,
        completed_at = NOW()
       WHERE id = $5 ${vf.clause}
       RETURNING *`,
      [sale_price || null, sale_notes || null, payment_method || null, req.user.id, req.params.id, ...vf.params]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lookup not found' });
    res.json({ lookup: result.rows[0] });
  } catch (err) {
    console.error('[Vending] Complete error:', err);
    res.status(500).json({ error: 'Failed to complete sale' });
  }
});

// ADMIN: PUT /api/vending/queue/:id/skip
router.put('/queue/:id/skip', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    const vf = vendorFilter(req, 3);
    const result = await pool.query(
      `UPDATE vending_lookups SET status = 'skipped', completed_by = $1, completed_at = NOW()
       WHERE id = $2 ${vf.clause} RETURNING *`,
      [req.user.id, req.params.id, ...vf.params]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lookup not found' });
    res.json({ lookup: result.rows[0] });
  } catch (err) {
    console.error('[Vending] Skip error:', err);
    res.status(500).json({ error: 'Failed to skip lookup' });
  }
});

// ADMIN: GET /api/vending/sales
router.get('/sales', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const vf = vendorFilter(req, 2, 'vl');
    const result = await pool.query(
      `SELECT vl.*, u.display_name as completed_by_name
       FROM vending_lookups vl
       LEFT JOIN users u ON vl.completed_by = u.id
       WHERE vl.status = 'completed'
         AND COALESCE(vl.type, 'sell') = 'sell'
         AND vl.completed_at::date = $1
         ${vf.clause}
       ORDER BY vl.completed_at DESC`,
      [date, ...vf.params]
    );

    const vf2 = vendorFilter(req, 2);
    const totalResult = await pool.query(
      `SELECT COALESCE(SUM(sale_price), 0) as total_sales, COUNT(*) as sale_count
       FROM vending_lookups
       WHERE status = 'completed' AND COALESCE(type, 'sell') = 'sell' AND completed_at::date = $1 ${vf2.clause}`,
      [date, ...vf2.params]
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
router.post('/buy-lookup', auth, requireVendorOrAdmin, async (req, res) => {
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

    // Save as buy lookup (vendor_id = current user if they're a vendor)
    const buyVendorId = req.isVendor ? req.user.id : null;
    const insertResult = await pool.query(
      `INSERT INTO vending_lookups (raw_input, set_code, card_number, card_name, set_name, set_id, image_url, market_price, currency, ip_address, type, vendor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'buy', $11)
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
        req.ip,
        buyVendorId
      ]
    );

    const recommendation = analyzeBuyRecommendation(pricingData);

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
        lastSoldDate: pricingData?.lastSoldDate || null,
        lastSoldPrice: pricingData?.lastSoldPrice || null,
        trends: pricingData?.trends || null,
        recommendation,
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
router.post('/buy-lookup-card', auth, requireVendorOrAdmin, async (req, res) => {
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

    const buyVendorId = req.isVendor ? req.user.id : null;
    const insertResult = await pool.query(
      `INSERT INTO vending_lookups (raw_input, set_code, card_number, card_name, set_name, set_id, image_url, market_price, currency, ip_address, type, vendor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'buy', $11)
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
        req.ip,
        buyVendorId
      ]
    );

    const recommendation = analyzeBuyRecommendation(pricingData);

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
        lastSoldDate: pricingData?.lastSoldDate || null,
        lastSoldPrice: pricingData?.lastSoldPrice || null,
        trends: pricingData?.trends || null,
        recommendation,
      }
    });

  } catch (err) {
    console.error('[Vending Buy] Lookup-card error:', err);
    res.status(500).json({ error: 'Failed to look up card' });
  }
});

// ADMIN: GET /api/vending/buys
router.get('/buys', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const vf = vendorFilter(req, 2, 'vl');
    const result = await pool.query(
      `SELECT vl.*, u.display_name as completed_by_name
       FROM vending_lookups vl
       LEFT JOIN users u ON vl.completed_by = u.id
       WHERE vl.status = 'completed'
         AND COALESCE(vl.type, 'sell') = 'buy'
         AND vl.completed_at::date = $1
         ${vf.clause}
       ORDER BY vl.completed_at DESC`,
      [date, ...vf.params]
    );

    const vf2 = vendorFilter(req, 2);
    const totalResult = await pool.query(
      `SELECT COALESCE(SUM(sale_price), 0) as total_buys, COUNT(*) as buy_count
       FROM vending_lookups
       WHERE status = 'completed' AND COALESCE(type, 'sell') = 'buy' AND completed_at::date = $1 ${vf2.clause}`,
      [date, ...vf2.params]
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

// ADMIN: GET /api/vending/buys/stats
// Returns buy statistics over a time period (default 30 days)
router.get('/buys/stats', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30', 10);
    const vf = vendorFilter(req, 1);

    // Get overall totals
    const totalsResult = await pool.query(
      `SELECT
        COUNT(*) as total_count,
        COALESCE(SUM(sale_price), 0) as total_value,
        COALESCE(AVG(sale_price), 0) as avg_value
       FROM vending_lookups
       WHERE status = 'completed'
         AND COALESCE(type, 'sell') = 'buy'
         AND completed_at >= NOW() - $1::interval
         ${vf.clause}`,
      [`${days} days`, ...vf.params]
    );

    const totals = totalsResult.rows[0];

    res.json({
      period_days: days,
      total_buys: parseInt(totals.total_count),
      total_value: parseFloat(totals.total_value),
      average_value: parseFloat(totals.avg_value),
    });
  } catch (err) {
    console.error('[Vending] Buy stats error:', err);
    res.status(500).json({ error: 'Failed to load buy stats' });
  }
});

// ADMIN: GET /api/vending/card-stats/:setId/:cardNumber
// Returns historical stats for a specific card
router.get('/card-stats/:setId/:cardNumber', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    const { setId, cardNumber } = req.params;
    const vf = vendorFilter(req, 3);

    // Get buy history for this card
    const buyResult = await pool.query(
      `SELECT
        COUNT(*) as buy_count,
        COALESCE(AVG(sale_price), 0) as avg_buy_price,
        COALESCE(MIN(sale_price), 0) as min_buy_price,
        COALESCE(MAX(sale_price), 0) as max_buy_price,
        MAX(completed_at) as last_buy_date
       FROM vending_lookups
       WHERE status = 'completed'
         AND COALESCE(type, 'sell') = 'buy'
         AND set_id = $1
         AND card_number = $2
         ${vf.clause}`,
      [setId, cardNumber, ...vf.params]
    );

    // Get sell history for this card
    const vf2 = vendorFilter(req, 3);
    const sellResult = await pool.query(
      `SELECT
        COUNT(*) as sell_count,
        COALESCE(AVG(sale_price), 0) as avg_sell_price,
        COALESCE(MIN(sale_price), 0) as min_sell_price,
        COALESCE(MAX(sale_price), 0) as max_sell_price,
        MAX(completed_at) as last_sell_date
       FROM vending_lookups
       WHERE status = 'completed'
         AND COALESCE(type, 'sell') = 'sell'
         AND set_id = $1
         AND card_number = $2
         ${vf2.clause}`,
      [setId, cardNumber, ...vf2.params]
    );

    const buyData = buyResult.rows[0];
    const sellData = sellResult.rows[0];

    res.json({
      buys: {
        count: parseInt(buyData.buy_count),
        avg_price: parseFloat(buyData.avg_buy_price),
        min_price: parseFloat(buyData.min_buy_price),
        max_price: parseFloat(buyData.max_buy_price),
        last_date: buyData.last_buy_date,
      },
      sells: {
        count: parseInt(sellData.sell_count),
        avg_price: parseFloat(sellData.avg_sell_price),
        min_price: parseFloat(sellData.min_sell_price),
        max_price: parseFloat(sellData.max_sell_price),
        last_date: sellData.last_sell_date,
      },
    });
  } catch (err) {
    console.error('[Vending] Card stats error:', err);
    res.status(500).json({ error: 'Failed to load card stats' });
  }
});

// ADMIN: Commit day summary
router.post('/commit-day', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    const date = req.body.date || new Date().toISOString().split('T')[0];
    const notes = req.body.notes || null;
    const summaryVendorId = req.isVendor ? req.user.id : null;

    const vf = vendorFilter(req, 2);
    const sellResult = await pool.query(
      `SELECT COALESCE(SUM(sale_price), 0) as total_sold, COUNT(*) as cards_sold
       FROM vending_lookups
       WHERE status = 'completed' AND COALESCE(type, 'sell') = 'sell' AND completed_at::date = $1 ${vf.clause}`,
      [date, ...vf.params]
    );
    const buyResult = await pool.query(
      `SELECT COALESCE(SUM(sale_price), 0) as total_bought, COUNT(*) as cards_bought
       FROM vending_lookups
       WHERE status = 'completed' AND COALESCE(type, 'sell') = 'buy' AND completed_at::date = $1 ${vf.clause}`,
      [date, ...vf.params]
    );

    const totalSold = parseFloat(sellResult.rows[0].total_sold);
    const cardsSold = parseInt(sellResult.rows[0].cards_sold);
    const totalBought = parseFloat(buyResult.rows[0].total_bought);
    const cardsBought = parseInt(buyResult.rows[0].cards_bought);
    const netProfit = totalSold - totalBought;

    // Delete existing summary for this date + vendor, then insert fresh
    await pool.query(
      'DELETE FROM vending_daily_summaries WHERE summary_date = $1 AND vendor_id IS NOT DISTINCT FROM $2',
      [date, summaryVendorId]
    );

    const result = await pool.query(
      `INSERT INTO vending_daily_summaries (summary_date, total_sold, cards_sold, total_bought, cards_bought, net_profit, notes, committed_by, vendor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [date, totalSold, cardsSold, totalBought, cardsBought, netProfit, notes, req.user.id, summaryVendorId]
    );

    res.json({ summary: result.rows[0] });
  } catch (err) {
    console.error('[Vending] Commit day error:', err);
    res.status(500).json({ error: 'Failed to commit day' });
  }
});

// ADMIN: Check if day is committed
router.get('/commit-day/check', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const summaryVendorId = req.isVendor ? req.user.id : null;
    const result = await pool.query(
      'SELECT * FROM vending_daily_summaries WHERE summary_date = $1 AND vendor_id IS NOT DISTINCT FROM $2',
      [date, summaryVendorId]
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
router.get('/commit-day/history', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    if (req.isVendor && !req.isAdmin) {
      const result = await pool.query(
        `SELECT vds.*, u.display_name as committed_by_name
         FROM vending_daily_summaries vds
         LEFT JOIN users u ON vds.committed_by = u.id
         WHERE vds.vendor_id = $1
         ORDER BY vds.summary_date DESC
         LIMIT 90`,
        [req.user.id]
      );
      return res.json({ summaries: result.rows });
    }
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
