const { Router } = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const {
  catalogueCache, marketDataCache, CATALOGUE_TTL, MARKET_DATA_TTL,
  getCached, setCache, checkRateLimit,
  convertSetIdToPokePulse, searchCatalogue, getMarketData,
  findMatchingCards, extractCardsArray, extractPricingRecords, formatPricingData,
  findCachedProducts, cacheCatalogueResults,
} = require('../lib/pricing');

const router = Router();

// ──────────────────────────────────────────────────────────────
// Card Lookup Helpers (shared logic from vending)
// ──────────────────────────────────────────────────────────────

const SET_CODE_MAP = {
  'SVI': 'sv01', 'PAL': 'sv02', 'OBF': 'sv03', 'MEW': 'sv03.5',
  'PAR': 'sv04', 'PAF': 'sv04.5', 'TEF': 'sv05', 'TWM': 'sv06',
  'SFA': 'sv06.5', 'SCR': 'sv07', 'SSP': 'sv08', 'PRE': 'sv08.5',
  'JTG': 'sv09', 'DRI': 'sv10', 'BLK': 'sv10.5b', 'WHT': 'sv10.5w', 'SVP': 'svp', 'SVE': 'sve',
  'A1': 'A1', 'A1A': 'A1a', 'A2': 'A2', 'A2A': 'A2a', 'A3': 'A3', 'P-A': 'P-A',
  'MEG': 'me01', 'PFL': 'me02', 'MEP': 'MEP',
  'SSH': 'swsh1', 'RCL': 'swsh2', 'DAA': 'swsh3', 'CPA': 'swsh3.5', 'VIV': 'swsh4',
  'SHF': 'swsh4.5', 'BST': 'swsh5', 'CRE': 'swsh6', 'EVS': 'swsh7', 'CEL': 'swsh7.5',
  'FST': 'swsh8', 'BRS': 'swsh9', 'ASR': 'swsh10', 'PGO': 'swsh10.5',
  'LOR': 'swsh11', 'SIT': 'swsh12', 'CRZ': 'swsh12.5',
  'SUM': 'sm1', 'GRI': 'sm2', 'BUS': 'sm3', 'SLG': 'sm35',
  'CIN': 'sm4', 'UPR': 'sm5', 'FLI': 'sm6', 'CES': 'sm7',
  'LOT': 'sm8', 'TEU': 'sm9', 'UNB': 'sm10', 'UNM': 'sm11', 'CEC': 'sm12',
  'XY': 'xy1', 'FLF': 'xy2', 'FFI': 'xy3', 'PHF': 'xy4',
  'PRC': 'xy5', 'ROS': 'xy6', 'AOR': 'xy7', 'BKT': 'xy8',
  'BKP': 'xy9', 'FCO': 'xy10', 'STS': 'xy11', 'EVO': 'xy12',
  'BS': 'base1', 'JU': 'base2', 'FO': 'base3', 'BS2': 'base4',
  'TR': 'base5', 'GY': 'base6',
};

function parseCardInput(input) {
  const trimmed = input.trim();

  const prefixedWithTotal = trimmed.match(/^([A-Za-z]+)\s*(\d+)\s*\/\s*([A-Za-z]+)\s*(\d+)$/);
  if (prefixedWithTotal && prefixedWithTotal[1].toUpperCase() === prefixedWithTotal[3].toUpperCase()) {
    return {
      type: 'prefixed_number',
      cardNumber: prefixedWithTotal[1].toUpperCase() + prefixedWithTotal[2],
      total: prefixedWithTotal[1].toUpperCase() + prefixedWithTotal[4],
    };
  }

  const setNumberTotal = trimmed.match(/^([A-Za-z0-9._-]+)\s+([A-Za-z]*)\s*(\d+)\s*\/\s*[A-Za-z]*\s*(\d+)$/);
  if (setNumberTotal) {
    const prefix = setNumberTotal[2];
    const num = setNumberTotal[3];
    return {
      type: 'set_number',
      setCode: setNumberTotal[1].toUpperCase(),
      cardNumber: (prefix + num).replace(/^0+/, '') || '0',
    };
  }

  const setNum = trimmed.match(/^([A-Za-z0-9._-]+)\s+([A-Za-z]*)\s*(\d+)$/);
  if (setNum) {
    const prefix = setNum[2];
    const num = setNum[3];
    return {
      type: 'set_number',
      setCode: setNum[1].toUpperCase(),
      cardNumber: (prefix + num).replace(/^0+/, '') || '0',
    };
  }

  const numOnly = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (numOnly) {
    return {
      type: 'number_only',
      cardNumber: numOnly[1].replace(/^0+/, '') || '0',
      total: numOnly[2],
    };
  }

  const prefixedNum = trimmed.match(/^([A-Za-z]+)\s*(\d+)$/);
  if (prefixedNum) {
    return {
      type: 'prefixed_number',
      cardNumber: prefixedNum[1].toUpperCase() + prefixedNum[2],
    };
  }

  return { type: 'name_search', query: trimmed };
}

async function resolveSetCode(setCode) {
  if (SET_CODE_MAP[setCode]) return SET_CODE_MAP[setCode];
  const directMatch = await pool.query(
    'SELECT DISTINCT set_id FROM card_index WHERE LOWER(set_id) = $1 LIMIT 1',
    [setCode.toLowerCase()]
  );
  if (directMatch.rows.length > 0) return directMatch.rows[0].set_id;
  const nameMatch = await pool.query(
    'SELECT DISTINCT set_id FROM card_index WHERE UPPER(set_name) LIKE $1 LIMIT 1',
    [`%${setCode}%`]
  );
  if (nameMatch.rows.length > 0) return nameMatch.rows[0].set_id;
  return null;
}

async function findCardInIndex(setId, cardNumber) {
  const exact = await pool.query(
    'SELECT * FROM card_index WHERE set_id = $1 AND UPPER(local_id) = UPPER($2) LIMIT 1',
    [setId, cardNumber]
  );
  if (exact.rows.length > 0) return exact.rows[0];
  const numericPart = parseInt(cardNumber, 10);
  if (!isNaN(numericPart) && String(numericPart) === cardNumber.replace(/^0+/, '')) {
    const padded = cardNumber.padStart(3, '0');
    const alt = await pool.query(
      'SELECT * FROM card_index WHERE set_id = $1 AND (local_id = $2 OR local_id = $3) LIMIT 1',
      [setId, padded, String(numericPart)]
    );
    if (alt.rows.length > 0) return alt.rows[0];
  }
  return null;
}

async function findSetsByTotal(total, cardNumber) {
  const result = await pool.query(
    `SELECT ci.* FROM card_index ci
     WHERE (ci.local_id = $1 OR ci.local_id = $2)
       AND ci.set_id IN (SELECT set_id FROM card_index WHERE local_id = $3 OR local_id = $4)
     ORDER BY ci.set_id`,
    [cardNumber, cardNumber.padStart(3, '0'), total, total.padStart(3, '0')]
  );
  return result.rows;
}

async function searchCardsByName(query) {
  const result = await pool.query(
    `SELECT * FROM card_index WHERE LOWER(name) LIKE $1 ORDER BY set_id, local_id LIMIT 20`,
    [`%${query.toLowerCase()}%`]
  );
  return result.rows;
}

async function getCardPricing(setId, cardNumber, cardName) {
  const ppRow = await pool.query(
    'SELECT pokepulse_set_id FROM card_index WHERE set_id = $1 AND pokepulse_set_id IS NOT NULL LIMIT 1',
    [setId]
  );
  const pokePulseSetId = ppRow.rows[0]?.pokepulse_set_id || convertSetIdToPokePulse(setId);

  let matchingCards = [];
  const cachedProducts = await findCachedProducts(pokePulseSetId, cardNumber);
  if (cachedProducts.length > 0) {
    matchingCards = cachedProducts;
  }

  if (matchingCards.length === 0) {
    const setIdsToTry = [pokePulseSetId];
    if (setId !== pokePulseSetId) setIdsToTry.push(setId);
    setIdsToTry.push(null);

    let cardsArray = null;
    for (const trySetId of setIdsToTry) {
      const catalogueCacheKey = `catalogue:${trySetId || 'noset'}:${cardName}`;
      let catalogueData = getCached(catalogueCache, catalogueCacheKey, CATALOGUE_TTL);
      if (!catalogueData) {
        checkRateLimit();
        catalogueData = await searchCatalogue(trySetId, cardName);
        setCache(catalogueCache, catalogueCacheKey, catalogueData);
      }
      cardsArray = extractCardsArray(catalogueData);
      if (cardsArray && cardsArray.length > 0) {
        cacheCatalogueResults(trySetId, cardsArray).catch(() => {});
        break;
      }
    }
    if (!cardsArray || cardsArray.length === 0) return null;
    matchingCards = findMatchingCards(cardsArray, cardNumber);
    if (matchingCards.length === 0) return null;
  }

  const productIds = matchingCards.map(c => c.product_id);
  const marketCacheKey = `market:${productIds.join(',')}`;
  let marketData = getCached(marketDataCache, marketCacheKey, MARKET_DATA_TTL);
  let cached = true;

  if (!marketData) {
    checkRateLimit();
    marketData = await getMarketData(productIds);
    setCache(marketDataCache, marketCacheKey, marketData);
    cached = false;
  }

  const variants = [];
  for (const card of matchingCards) {
    const pricingRecords = extractPricingRecords(marketData, card.product_id);
    if (!pricingRecords || pricingRecords.length === 0) continue;
    const pricing = formatPricingData(pricingRecords, card.product_id, cached);
    variants.push({
      material: card.material || null,
      product_id: card.product_id,
      market_price: pricing.marketPrice,
      currency: pricing.currency,
      conditions: pricing.conditions,
      trends: pricing.trends,
    });
  }

  if (variants.length === 0) return null;
  const first = variants[0];
  return {
    marketPrice: first.market_price,
    currency: first.currency,
    conditions: first.conditions,
    trends: first.trends,
    variants: variants.length > 1 ? variants : undefined,
  };
}

// Rate limiting for public endpoints
const ipLookupCounts = new Map();
const IP_RATE_LIMIT = 30;
const IP_RATE_WINDOW = 60 * 60 * 1000;

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

// ──────────────────────────────────────────────────────────────
// Helper: perform a card lookup and return result (no DB save)
// ──────────────────────────────────────────────────────────────

async function performLookup(input, ip) {
  if (!checkIpRateLimit(ip)) {
    return { error: 'Too many lookups. Please wait a moment.', status: 429 };
  }

  const parsed = parseCardInput(input);

  // Name search
  if (parsed.type === 'name_search') {
    const cards = await searchCardsByName(parsed.query);
    if (cards.length === 0) return { results: [], message: 'No cards found' };
    return {
      results: cards.map(c => ({
        name: c.name, set_id: c.set_id, set_name: c.set_name,
        local_id: c.local_id, image_url: c.image_url, rarity: c.rarity,
      })),
    };
  }

  // Prefixed number (e.g. SV107)
  if (parsed.type === 'prefixed_number') {
    let query, params;
    if (parsed.total) {
      query = `SELECT * FROM card_index WHERE UPPER(local_id) = UPPER($1)
               AND set_id IN (SELECT set_id FROM card_index WHERE UPPER(local_id) = UPPER($2))
               ORDER BY set_id`;
      params = [parsed.cardNumber, parsed.total];
    } else {
      query = 'SELECT * FROM card_index WHERE UPPER(local_id) = UPPER($1) ORDER BY set_id';
      params = [parsed.cardNumber];
    }
    const matches = await pool.query(query, params);
    if (matches.rows.length === 0) return { results: [], message: `No card found with number ${parsed.cardNumber}` };
    if (matches.rows.length === 1) {
      return await buildLookupResult(matches.rows[0], parsed.cardNumber);
    }
    return {
      results: matches.rows.map(c => ({
        name: c.name, set_id: c.set_id, set_name: c.set_name,
        local_id: c.local_id, image_url: c.image_url, rarity: c.rarity,
      })),
    };
  }

  // Number only (e.g. 089/191)
  if (parsed.type === 'number_only') {
    const possibleSets = await findSetsByTotal(parsed.total, parsed.cardNumber);
    if (possibleSets.length === 0) {
      return { results: [], message: `Couldn't identify the set. Try including the set code.` };
    }
    if (possibleSets.length === 1) {
      return await buildLookupResult(possibleSets[0], parsed.cardNumber);
    }
    return {
      results: possibleSets.map(c => ({
        name: c.name, set_id: c.set_id, set_name: c.set_name,
        local_id: c.local_id, image_url: c.image_url, rarity: c.rarity,
      })),
    };
  }

  // Set + number (e.g. MEG 089)
  const setId = await resolveSetCode(parsed.setCode);
  if (!setId) {
    // Try as prefixed card number
    const prefixedCard = parsed.setCode + parsed.cardNumber;
    const pfMatches = await pool.query(
      'SELECT * FROM card_index WHERE UPPER(local_id) = UPPER($1) ORDER BY set_id',
      [prefixedCard]
    );
    if (pfMatches.rows.length === 1) {
      return await buildLookupResult(pfMatches.rows[0], prefixedCard);
    }
    if (pfMatches.rows.length > 1) {
      return {
        results: pfMatches.rows.map(c => ({
          name: c.name, set_id: c.set_id, set_name: c.set_name,
          local_id: c.local_id, image_url: c.image_url, rarity: c.rarity,
        })),
      };
    }
    return { results: [], message: `Unknown set code "${parsed.setCode}". Try searching by card name.` };
  }

  const card = await findCardInIndex(setId, parsed.cardNumber);
  if (!card) {
    return { results: [], message: `Card #${parsed.cardNumber} not found in set ${parsed.setCode}` };
  }

  return await buildLookupResult(card, parsed.cardNumber);
}

async function buildLookupResult(card, cardNumber) {
  let pricingData = null;
  try {
    pricingData = await getCardPricing(card.set_id, cardNumber, card.name);
  } catch (err) {
    console.error('[Seller] Pricing error:', err.message);
  }

  return {
    lookup: {
      card_name: card.name,
      set_name: card.set_name,
      set_id: card.set_id,
      card_number: cardNumber,
      image_url: card.image_url,
      rarity: card.rarity,
      market_price: pricingData?.marketPrice || null,
      currency: pricingData?.currency || 'GBP',
      conditions: pricingData?.conditions || null,
      trends: pricingData?.trends || null,
      variants: pricingData?.variants || undefined,
    },
  };
}

// ──────────────────────────────────────────────────────────────
// PUBLIC ENDPOINTS
// ──────────────────────────────────────────────────────────────

// GET /api/seller/vendor/:code — get vendor display name
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
    console.error('[Seller] Vendor info error:', err);
    res.status(500).json({ error: 'Failed to load vendor info' });
  }
});

// POST /api/seller/lookup — card search
router.post('/lookup', async (req, res) => {
  try {
    const { input } = req.body;
    if (!input || !input.trim()) {
      return res.status(400).json({ error: 'Please enter a card ID or name' });
    }
    const result = await performLookup(input.trim(), req.ip);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Seller] Lookup error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// POST /api/seller/lookup-card — select card from search results
router.post('/lookup-card', async (req, res) => {
  try {
    const { name, set_id, local_id } = req.body;
    if (!name || !set_id) {
      return res.status(400).json({ error: 'Card name and set_id required' });
    }

    const card = await pool.query(
      'SELECT * FROM card_index WHERE set_id = $1 AND name = $2 LIMIT 1',
      [set_id, name]
    );

    if (card.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const match = card.rows[0];
    const cardNumber = local_id || match.local_id;
    const result = await buildLookupResult(match, cardNumber);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Seller] Lookup-card error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// POST /api/seller/submit — submit basket of cards to sell
router.post('/submit', async (req, res) => {
  try {
    const { seller_name, seller_email, seller_phone, vendor_code, items } = req.body;

    if (!seller_name || !seller_name.trim()) {
      return res.status(400).json({ error: 'Your name is required' });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one card is required' });
    }
    if (items.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 items per submission' });
    }

    // Resolve vendor
    let vendorId = null;
    if (vendor_code) {
      const vr = await pool.query(
        'SELECT id FROM users WHERE UPPER(vendor_code) = UPPER($1) AND is_vendor = true',
        [vendor_code]
      );
      if (vr.rows.length > 0) vendorId = vr.rows[0].id;
    }

    // Generate unique submission ID
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const submissionId = `TM-${timestamp}-${random}`;

    const totalAsking = items.reduce((sum, item) => sum + (parseFloat(item.asking_price) || 0), 0);

    // Create submission
    await pool.query(
      `INSERT INTO seller_submissions (submission_id, seller_name, seller_email, seller_phone, total_items, total_asking, vendor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [submissionId, seller_name.trim(), seller_email || null, seller_phone || null, items.length, totalAsking || null, vendorId]
    );

    // Insert items
    for (const item of items) {
      await pool.query(
        `INSERT INTO seller_submission_items
         (submission_id, card_name, set_name, set_id, card_number, image_url, market_price, asking_price, condition)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          submissionId,
          item.card_name || null,
          item.set_name || null,
          item.set_id || null,
          item.card_number || null,
          item.image_url || null,
          item.market_price || null,
          item.asking_price || null,
          item.condition || 'NM',
        ]
      );
    }

    console.log(`[Seller] New submission: ${submissionId} — ${items.length} items from ${seller_name.trim()}`);

    res.json({
      success: true,
      submission_id: submissionId,
      count: items.length,
    });
  } catch (err) {
    console.error('[Seller] Submit error:', err);
    res.status(500).json({ error: 'Submission failed' });
  }
});

// POST /api/seller/submission/:id/contact — add contact info after submission
router.post('/submission/:id/contact', async (req, res) => {
  try {
    const { email, phone } = req.body;
    const result = await pool.query(
      `UPDATE seller_submissions SET seller_email = COALESCE($1, seller_email), seller_phone = COALESCE($2, seller_phone), updated_at = NOW()
       WHERE submission_id = $3 RETURNING submission_id`,
      [email || null, phone || null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Seller] Contact update error:', err);
    res.status(500).json({ error: 'Failed to save contact info' });
  }
});

// GET /api/seller/submission/:id/status — check submission status
router.get('/submission/:id/status', async (req, res) => {
  try {
    const sub = await pool.query(
      'SELECT * FROM seller_submissions WHERE submission_id = $1',
      [req.params.id]
    );
    if (sub.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const items = await pool.query(
      'SELECT * FROM seller_submission_items WHERE submission_id = $1 ORDER BY id',
      [req.params.id]
    );

    res.json({
      ...sub.rows[0],
      items: items.rows,
    });
  } catch (err) {
    console.error('[Seller] Status check error:', err);
    res.status(500).json({ error: 'Failed to load status' });
  }
});

// ──────────────────────────────────────────────────────────────
// ADMIN ENDPOINTS (auth required)
// ──────────────────────────────────────────────────────────────

// GET /api/seller/submissions — list submissions (filtered by vendor for non-admins)
router.get('/submissions', auth, async (req, res) => {
  try {
    const status = req.query.status || 'pending';

    // Check if user is admin or vendor
    const userResult = await pool.query('SELECT is_admin, is_vendor FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    if (!user || (!user.is_admin && !user.is_vendor)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    let result;
    if (user.is_admin) {
      // Admins see submissions without a vendor (their own) or all if no vendor filter
      result = await pool.query(
        `SELECT ss.*,
          (SELECT COUNT(*) FROM seller_submission_items WHERE submission_id = ss.submission_id) as item_count
         FROM seller_submissions ss
         WHERE ss.status = $1
         ORDER BY ss.created_at DESC
         LIMIT 100`,
        [status]
      );
    } else {
      // Vendors only see their own submissions
      result = await pool.query(
        `SELECT ss.*,
          (SELECT COUNT(*) FROM seller_submission_items WHERE submission_id = ss.submission_id) as item_count
         FROM seller_submissions ss
         WHERE ss.status = $1 AND ss.vendor_id = $2
         ORDER BY ss.created_at DESC
         LIMIT 100`,
        [status, req.user.id]
      );
    }

    res.json({ submissions: result.rows });
  } catch (err) {
    console.error('[Seller] List submissions error:', err);
    res.status(500).json({ error: 'Failed to load submissions' });
  }
});

// GET /api/seller/submissions/:id — get submission detail with items
router.get('/submissions/:id', auth, async (req, res) => {
  try {
    const sub = await pool.query(
      'SELECT * FROM seller_submissions WHERE submission_id = $1',
      [req.params.id]
    );
    if (sub.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const items = await pool.query(
      'SELECT * FROM seller_submission_items WHERE submission_id = $1 ORDER BY id',
      [req.params.id]
    );

    res.json({ submission: sub.rows[0], items: items.rows });
  } catch (err) {
    console.error('[Seller] Get submission error:', err);
    res.status(500).json({ error: 'Failed to load submission' });
  }
});

// PUT /api/seller/submissions/:id/status — update submission status + notes
router.put('/submissions/:id/status', auth, async (req, res) => {
  try {
    const { status, admin_notes } = req.body;
    const validStatuses = ['pending', 'reviewing', 'offered', 'accepted', 'rejected', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // If marking as offered, calculate total offered
    let totalOffered = null;
    if (status === 'offered' || status === 'accepted') {
      const items = await pool.query(
        'SELECT offer_price FROM seller_submission_items WHERE submission_id = $1 AND offer_price IS NOT NULL',
        [req.params.id]
      );
      totalOffered = items.rows.reduce((sum, i) => sum + parseFloat(i.offer_price), 0);
    }

    const result = await pool.query(
      `UPDATE seller_submissions SET status = $1, admin_notes = COALESCE($2, admin_notes), total_offered = COALESCE($3, total_offered), updated_at = NOW()
       WHERE submission_id = $4 RETURNING *`,
      [status, admin_notes || null, totalOffered, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json({ success: true, submission: result.rows[0] });
  } catch (err) {
    console.error('[Seller] Update status error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// PUT /api/seller/items/:itemId — update individual item (offer_price, status, notes)
router.put('/items/:itemId', auth, async (req, res) => {
  try {
    const { offer_price, status, notes } = req.body;
    const updates = [];
    const params = [];
    let paramIdx = 1;

    if (offer_price !== undefined) {
      updates.push(`offer_price = $${paramIdx++}`);
      params.push(offer_price === null ? null : parseFloat(offer_price));
    }
    if (status !== undefined) {
      updates.push(`status = $${paramIdx++}`);
      params.push(status);
    }
    if (notes !== undefined) {
      updates.push(`notes = $${paramIdx++}`);
      params.push(notes);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    params.push(parseInt(req.params.itemId));
    const result = await pool.query(
      `UPDATE seller_submission_items SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    console.error('[Seller] Update item error:', err);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

module.exports = router;
