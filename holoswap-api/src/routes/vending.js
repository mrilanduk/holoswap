const { Router } = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const {
  catalogueCache, marketDataCache, CATALOGUE_TTL, MARKET_DATA_TTL,
  getCached, setCache, checkRateLimit,
  convertSetIdToPokePulse, searchCatalogue, getMarketData,
  findMatchingCard, matchCardNumber, extractCardsArray, extractPricingRecords, formatPricingData,
  analyzeBuyRecommendation, savePriceHistory,
  findCachedProduct, findCachedGradedProducts, cacheCatalogueResults, getCatalogueStats,
  searchCatalogueGraded
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
  'JTG': 'sv09', 'DRI': 'sv10', 'BLK': 'sv10.5b', 'WHT': 'sv10.5w', 'SVP': 'svp', 'SVE': 'sve',
  // Pokemon TCG Pocket
  'A1': 'A1', 'A1A': 'A1a', 'A2': 'A2', 'A2A': 'A2a', 'A3': 'A3',
  'P-A': 'P-A',
  // Mega evolution sets
  'MEG': 'me01', 'PFL': 'me02', 'MEP': 'MEP',
  // Sword & Shield era
  'SSH': 'swsh1', 'RCL': 'swsh2', 'DAA': 'swsh3', 'CPA': 'swsh3.5', 'VIV': 'swsh4',
  'SHF': 'swsh4.5', 'BST': 'swsh5', 'CRE': 'swsh6', 'EVS': 'swsh7', 'CEL': 'swsh7.5',
  'FST': 'swsh8', 'BRS': 'swsh9', 'ASR': 'swsh10', 'PGO': 'swsh10.5',
  'LOR': 'swsh11', 'SIT': 'swsh12', 'CRZ': 'swsh12.5',
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

  // Pattern: "SV107/SV122" or "SV 107/SV 122" — same letter prefix on both sides = prefixed card number
  const prefixedWithTotal = trimmed.match(/^([A-Za-z]+)\s*(\d+)\s*\/\s*([A-Za-z]+)\s*(\d+)$/);
  if (prefixedWithTotal && prefixedWithTotal[1].toUpperCase() === prefixedWithTotal[3].toUpperCase()) {
    const prefix = prefixedWithTotal[1].toUpperCase();
    return {
      type: 'prefixed_number',
      cardNumber: prefix + prefixedWithTotal[2],
      total: prefix + prefixedWithTotal[4],
    };
  }

  // Pattern: "MEG 089/123" or "SVI 199/258" or "SHF SV107/SV122" or "SHF SV 107/SV 122"
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

  // Pattern: "MEG 089" or "SHF SV107" or "SHF SV 107"
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

  // Pattern: "089/123" (number only)
  const numOnly = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (numOnly) {
    return {
      type: 'number_only',
      cardNumber: numOnly[1].replace(/^0+/, '') || '0',
      total: numOnly[2],
    };
  }

  // Pattern: "SV107" or "TG15" (prefixed card number, no set code)
  const prefixedNum = trimmed.match(/^([A-Za-z]+)\s*(\d+)$/);
  if (prefixedNum) {
    return {
      type: 'prefixed_number',
      cardNumber: prefixedNum[1].toUpperCase() + prefixedNum[2],
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
  // Try exact local_id match (case-insensitive for prefixed numbers like SV107)
  const exact = await pool.query(
    'SELECT * FROM card_index WHERE set_id = $1 AND UPPER(local_id) = UPPER($2) LIMIT 1',
    [setId, cardNumber]
  );
  if (exact.rows.length > 0) return exact.rows[0];

  // Try with leading zeros stripped/added (only for pure numeric card numbers)
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

// Find sets by total card count + card number (for "089/191" input with no set code)
// The "/191" on a card means 191 regular cards — secret rares go higher.
// So we find sets that contain a card numbered exactly = total (proving the set reaches that number)
// AND contain the requested card number.
async function findSetsByTotal(total, cardNumber) {
  const result = await pool.query(
    `SELECT ci.*
     FROM card_index ci
     WHERE (ci.local_id = $1 OR ci.local_id = $2)
       AND ci.set_id IN (
         SELECT set_id FROM card_index
         WHERE local_id = $3 OR local_id = $4
       )
     ORDER BY ci.set_id`,
    [
      cardNumber,
      cardNumber.padStart(3, '0'),
      total,
      total.padStart(3, '0')
    ]
  );
  return result.rows;
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
  // Read pokepulse_set_id from card_index (no runtime conversion needed)
  const ppRow = await pool.query('SELECT pokepulse_set_id FROM card_index WHERE set_id = $1 AND pokepulse_set_id IS NOT NULL LIMIT 1', [setId]);
  const pokePulseSetId = ppRow.rows[0]?.pokepulse_set_id || convertSetIdToPokePulse(setId);
  console.log(`[Vending] setId: ${setId} → pokepulse: ${pokePulseSetId}`);

  let productId = null;

  // Step 1: Check DB cache for product_id (skips catalogue API entirely)
  const cachedProduct = await findCachedProduct(pokePulseSetId, cardNumber);
  if (cachedProduct) {
    productId = cachedProduct.product_id;
    console.log(`[Vending] DB cache hit → product_id: ${productId}`);
  }

  // Step 2: If no cache hit, search PokePulse catalogue API
  if (!productId) {
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

      if (cardsArray && cardsArray.length > 0) {
        // Cache ALL results to DB for future lookups
        cacheCatalogueResults(trySetId, cardsArray).catch(err =>
          console.error('[Vending] Cache save error:', err.message)
        );
        break;
      }
    }

    if (!cardsArray || cardsArray.length === 0) return null;

    const matchingCard = findMatchingCard(cardsArray, cardNumber);
    if (!matchingCard) return null;

    productId = matchingCard.product_id;
    console.log(`[Vending] Catalogue API → product_id: ${productId}`);
  }

  // Step 3: Get market data (always needed, short cache)
  const marketCacheKey = `market:${productId}`;
  let marketData = getCached(marketDataCache, marketCacheKey, MARKET_DATA_TTL);
  let cached = true;

  if (!marketData) {
    checkRateLimit();
    console.log(`[Vending] Market data fetch for: ${productId}`);
    marketData = await getMarketData(productId);
    console.log(`[Vending] Market data response:`, JSON.stringify(marketData).substring(0, 500));
    setCache(marketDataCache, marketCacheKey, marketData);
    cached = false;
  }

  const pricingRecords = extractPricingRecords(marketData, productId);
  if (!pricingRecords || pricingRecords.length === 0) {
    console.log(`[Vending] No pricing records found for ${productId}`);
    return null;
  }

  return formatPricingData(pricingRecords, productId, cached);
}

// Get slab/graded pricing for a card (PSA, CGC, BGS)
// Parse grading company and grade from product_id
// Format: card:setId|cardNumber|material|...|COMPANY|grade
const SLAB_COMPANIES = ['PSA', 'ACE', 'TAG', 'CGC'];
const SLAB_GRADE = '10';

function parseGradeInfo(productId) {
  const parts = productId.split('|');
  if (parts.length >= 6) {
    const company = parts[parts.length - 2];
    const grade = parts[parts.length - 1];
    if (company && grade && company !== 'null') {
      return { company, grade };
    }
  }
  return null;
}

async function getSlabPricing(setId, cardNumber, cardName) {
  try {
    // Step 1: Find the raw product_id to derive the graded product_ids
    const ppRow = await pool.query('SELECT pokepulse_set_id FROM card_index WHERE set_id = $1 AND pokepulse_set_id IS NOT NULL LIMIT 1', [setId]);
    const pokePulseSetId = ppRow.rows[0]?.pokepulse_set_id || convertSetIdToPokePulse(setId);

    // Find the raw (ungraded) product in cache
    const rawProduct = await findCachedProduct(pokePulseSetId, cardNumber);
    if (!rawProduct) {
      console.log(`[Slab] No raw product cached for ${pokePulseSetId} #${cardNumber}`);
      return [];
    }

    // Step 2: Construct graded product_ids from the raw product_id
    // Raw: card:sv3pt5|199/165|null|null|null|null
    // Graded: card:sv3pt5|199/165|null|null|PSA|10
    const parts = rawProduct.product_id.split('|');
    if (parts.length < 6) return [];

    const base = parts.slice(0, 4).join('|'); // card:set|number|material|field4
    const gradedIds = SLAB_COMPANIES.map(company => `${base}|${company}|${SLAB_GRADE}`);

    console.log(`[Slab] Batch fetching: ${gradedIds.map(id => parseGradeInfo(id)?.company).join(', ')}`);

    // Step 3: Single batch market data call for all companies
    checkRateLimit();
    const marketData = await getMarketData(gradedIds);

    // Step 4: Extract prices for each company
    const slabs = [];
    const data = marketData?.data || marketData || {};

    for (const productId of gradedIds) {
      const records = data[productId];
      if (!records || records.length === 0) continue;

      const record = records.find(r => parseFloat(r.value) > 0) || records[0];
      const price = parseFloat(record.value) || 0;
      const currency = record.currency === '£' ? 'GBP' : (record.currency || 'GBP');
      const info = parseGradeInfo(productId);

      if (price > 0) {
        console.log(`[Slab] ${info.company} ${info.grade}: £${price}`);
        slabs.push({
          grade: `${info.company} ${info.grade}`,
          market_price: price,
          currency: currency,
          trends: record.trends ? {
            '7day': {
              percentage: record.trends['7d']?.percentage_change || 0,
              previous: record.trends['7d']?.previous_value || 0,
            }
          } : null,
        });
      }
    }

    console.log(`[Slab] Returning ${slabs.length} slabs`);
    return slabs;
  } catch (err) {
    console.error('[Slab] Error:', err.message);
    return [];
  }
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

    // Prefixed card number mode (e.g. "SV107", "TG15", "SV107/SV122") — search by local_id across all sets
    if (parsed.type === 'prefixed_number') {
      let query, params;
      if (parsed.total) {
        // Have a total (e.g. SV107/SV122) — narrow to sets that also contain the total card
        query = `SELECT * FROM card_index WHERE UPPER(local_id) = UPPER($1)
                 AND set_id IN (SELECT set_id FROM card_index WHERE UPPER(local_id) = UPPER($2))
                 ORDER BY set_id`;
        params = [parsed.cardNumber, parsed.total];
      } else {
        query = 'SELECT * FROM card_index WHERE UPPER(local_id) = UPPER($1) ORDER BY set_id';
        params = [parsed.cardNumber];
      }
      const matches = await pool.query(query, params);

      if (matches.rows.length === 0) {
        return res.json({ success: true, results: [], message: `No card found with number ${parsed.cardNumber}` });
      }

      if (matches.rows.length === 1) {
        const match = matches.rows[0];
        let pricingData = null;
        let slabData = [];
        try {
          pricingData = await getCardPricing(match.set_id, parsed.cardNumber, match.name);
          slabData = await getSlabPricing(match.set_id, parsed.cardNumber, match.name);
        } catch (pricingErr) {
          console.error('[Vending] Pricing error:', pricingErr.message);
        }

        const insertResult = await pool.query(
          `INSERT INTO vending_lookups (raw_input, set_code, card_number, card_name, set_name, set_id, image_url, market_price, currency, ip_address, vendor_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [input.trim(), null, parsed.cardNumber, match.name, match.set_name, match.set_id, match.image_url, pricingData?.marketPrice || null, pricingData?.currency || 'GBP', req.ip, vendorId]
        );

        return res.json({
          success: true,
          lookup: {
            id: insertResult.rows[0].id,
            card_name: match.name,
            set_name: match.set_name,
            set_id: match.set_id,
            card_number: parsed.cardNumber,
            image_url: match.image_url,
            rarity: match.rarity,
            market_price: pricingData?.marketPrice || null,
            currency: pricingData?.currency || 'GBP',
            conditions: pricingData?.conditions || null,
            trends: pricingData?.trends || null,
            slab_pricing: slabData || [],
          }
        });
      }

      // Multiple matches — return options
      return res.json({
        success: true,
        results: matches.rows.map(c => ({
          name: c.name,
          set_id: c.set_id,
          set_name: c.set_name,
          local_id: c.local_id,
          image_url: c.image_url,
          rarity: c.rarity,
        })),
        message: `Found ${matches.rows.length} cards with number ${parsed.cardNumber}. Please select one.`
      });
    }

    // Number-only mode (no set code) — use total to identify the set
    if (parsed.type === 'number_only') {
      const possibleSets = await findSetsByTotal(parsed.total, parsed.cardNumber);

      if (possibleSets.length === 0) {
        return res.json({
          success: true,
          results: [],
          message: `Couldn't identify the set from "${input}". Try including the set code (e.g. SVI ${parsed.cardNumber}/${parsed.total}).`
        });
      }

      // If exactly one match, go straight to pricing
      if (possibleSets.length === 1) {
        const match = possibleSets[0];
        let pricingData = null;
        let slabData = [];
        try {
          pricingData = await getCardPricing(match.set_id, parsed.cardNumber, match.name);
          slabData = await getSlabPricing(match.set_id, parsed.cardNumber, match.name);
        } catch (pricingErr) {
          console.error('[Vending] Pricing error:', pricingErr.message);
        }

        const insertResult = await pool.query(
          `INSERT INTO vending_lookups (raw_input, set_code, card_number, card_name, set_name, set_id, image_url, market_price, currency, ip_address, vendor_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            input.trim(),
            null,
            parsed.cardNumber,
            match.name,
            match.set_name,
            match.set_id,
            match.image_url,
            pricingData?.marketPrice || null,
            pricingData?.currency || 'GBP',
            req.ip,
            vendorId
          ]
        );

        return res.json({
          success: true,
          lookup: {
            id: insertResult.rows[0].id,
            card_name: match.name,
            set_name: match.set_name,
            set_id: match.set_id,
            card_number: parsed.cardNumber,
            image_url: match.image_url,
            rarity: match.rarity,
            market_price: pricingData?.marketPrice || null,
            currency: pricingData?.currency || 'GBP',
            conditions: pricingData?.conditions || null,
            trends: pricingData?.trends || null,
            slab_pricing: slabData || [],
          }
        });
      }

      // Multiple matches — return options for user to pick
      return res.json({
        success: true,
        results: possibleSets.map(c => ({
          name: c.name,
          set_id: c.set_id,
          set_name: c.set_name,
          local_id: c.local_id,
          image_url: c.image_url,
          rarity: c.rarity,
        })),
        message: `Found ${possibleSets.length} possible matches for #${parsed.cardNumber}/${parsed.total}. Please select one.`
      });
    }

    // Set + number mode
    const setId = await resolveSetCode(parsed.setCode);
    if (!setId) {
      // Fallback: maybe "set code" is actually a card number prefix (e.g. "SV 107" → SV107)
      const prefixedCard = parsed.setCode + parsed.cardNumber;
      const totalMatch = input.trim().match(/\/\s*[A-Za-z]*\s*(\d+)$/);
      const prefixedTotal = totalMatch ? parsed.setCode + totalMatch[1] : null;

      let pfQuery, pfParams;
      if (prefixedTotal) {
        pfQuery = `SELECT * FROM card_index WHERE UPPER(local_id) = UPPER($1)
                   AND set_id IN (SELECT set_id FROM card_index WHERE UPPER(local_id) = UPPER($2))
                   ORDER BY set_id`;
        pfParams = [prefixedCard, prefixedTotal];
      } else {
        pfQuery = 'SELECT * FROM card_index WHERE UPPER(local_id) = UPPER($1) ORDER BY set_id';
        pfParams = [prefixedCard];
      }
      const pfMatches = await pool.query(pfQuery, pfParams);

      if (pfMatches.rows.length === 1) {
        const match = pfMatches.rows[0];
        let pricingData = null;
        let slabData = [];
        try {
          pricingData = await getCardPricing(match.set_id, prefixedCard, match.name);
          slabData = await getSlabPricing(match.set_id, prefixedCard, match.name);
        } catch (pricingErr) {
          console.error('[Vending] Pricing error:', pricingErr.message);
        }

        const insertResult = await pool.query(
          `INSERT INTO vending_lookups (raw_input, set_code, card_number, card_name, set_name, set_id, image_url, market_price, currency, ip_address, vendor_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [input.trim(), null, prefixedCard, match.name, match.set_name, match.set_id, match.image_url, pricingData?.marketPrice || null, pricingData?.currency || 'GBP', req.ip, vendorId]
        );

        return res.json({
          success: true,
          lookup: {
            id: insertResult.rows[0].id,
            card_name: match.name,
            set_name: match.set_name,
            set_id: match.set_id,
            card_number: prefixedCard,
            image_url: match.image_url,
            rarity: match.rarity,
            market_price: pricingData?.marketPrice || null,
            currency: pricingData?.currency || 'GBP',
            conditions: pricingData?.conditions || null,
            trends: pricingData?.trends || null,
            slab_pricing: slabData || [],
          }
        });
      }

      if (pfMatches.rows.length > 1) {
        return res.json({
          success: true,
          results: pfMatches.rows.map(c => ({
            name: c.name, set_id: c.set_id, set_name: c.set_name,
            local_id: c.local_id, image_url: c.image_url, rarity: c.rarity,
          })),
          message: `Found ${pfMatches.rows.length} cards with number ${prefixedCard}. Please select one.`
        });
      }

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
    let slabData = [];
    try {
      pricingData = await getCardPricing(setId, parsed.cardNumber, card.name);
      slabData = await getSlabPricing(setId, parsed.cardNumber, card.name);
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
        slab_pricing: slabData || [],
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
    let slabData = [];
    try {
      pricingData = await getCardPricing(set_id, local_id, name);
      slabData = await getSlabPricing(set_id, local_id, name);
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
        slab_pricing: slabData || [],
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
    const { lookup_ids, customer_name } = req.body;
    if (!lookup_ids || !Array.isArray(lookup_ids) || lookup_ids.length === 0) {
      return res.status(400).json({ error: 'No items to submit' });
    }

    const basketId = `basket_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const name = customer_name ? customer_name.trim().substring(0, 100) : null;

    const intIds = lookup_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    const result = await pool.query(
      `UPDATE vending_lookups SET basket_id = $1, customer_name = $2 WHERE id = ANY($3::int[]) AND status = 'pending'`,
      [basketId, name, intIds]
    );

    console.log(`[Vending] Submit basket: ${intIds.length} IDs sent, ${result.rowCount} rows updated, basket_id=${basketId}, customer=${name || 'anonymous'}`);
    res.json({ success: true, basket_id: basketId, count: result.rowCount });
  } catch (err) {
    console.error('[Vending] Submit basket error:', err);
    res.status(500).json({ error: 'Failed to submit basket' });
  }
});

// PUBLIC: POST /api/vending/basket/:basketId/contact
// Customer optionally provides email/phone after submitting basket
router.post('/basket/:basketId/contact', async (req, res) => {
  try {
    const { email, phone } = req.body;
    const basketId = req.params.basketId;

    if (!basketId || !basketId.startsWith('basket_')) {
      return res.status(400).json({ error: 'Invalid basket ID' });
    }

    const result = await pool.query(
      `UPDATE vending_lookups SET customer_email = $1, customer_phone = $2 WHERE basket_id = $3`,
      [email ? email.trim().substring(0, 255) : null, phone ? phone.trim().substring(0, 50) : null, basketId]
    );

    console.log(`[Vending] Basket contact: ${basketId} → email=${email || 'none'}, phone=${phone || 'none'}, ${result.rowCount} rows updated`);
    res.json({ success: true, updated: result.rowCount });
  } catch (err) {
    console.error('[Vending] Basket contact error:', err);
    res.status(500).json({ error: 'Failed to save contact info' });
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
      `SELECT * FROM vending_lookups WHERE status = $1 AND COALESCE(type, 'sell') = 'sell' AND basket_id IS NOT NULL ${vf.clause} ORDER BY created_at DESC LIMIT 50`,
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

    // Prefixed card number mode (e.g. "SV107", "TG15", "SV107/SV122")
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

      if (matches.rows.length === 0) {
        return res.json({ success: true, results: [], message: `No card found with number ${parsed.cardNumber}` });
      }

      if (matches.rows.length === 1) {
        const match = matches.rows[0];
        let pricingData = null;
        let slabData = [];
        try {
          pricingData = await getCardPricing(match.set_id, parsed.cardNumber, match.name);
          slabData = await getSlabPricing(match.set_id, parsed.cardNumber, match.name);
          if (pricingData) {
            savePriceHistory(match.set_id, parsed.cardNumber, match.name, pricingData).catch(err =>
              console.error('[Vending] Price history save failed:', err)
            );
          }
        } catch (pricingErr) {
          console.error('[Vending Buy] Pricing error:', pricingErr.message);
        }

        const buyVendorId = req.isVendor ? req.user.id : null;
        const insertResult = await pool.query(
          `INSERT INTO vending_lookups (raw_input, set_code, card_number, card_name, set_name, set_id, image_url, market_price, currency, ip_address, type, vendor_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'buy', $11)
           RETURNING id`,
          [input.trim(), null, parsed.cardNumber, match.name, match.set_name, match.set_id, match.image_url, pricingData?.marketPrice || null, pricingData?.currency || 'GBP', req.ip, buyVendorId]
        );

        return res.json({
          success: true,
          lookup: {
            id: insertResult.rows[0].id,
            card_name: match.name,
            set_name: match.set_name,
            set_id: match.set_id,
            card_number: parsed.cardNumber,
            image_url: match.image_url,
            rarity: match.rarity,
            market_price: pricingData?.marketPrice || null,
            currency: pricingData?.currency || 'GBP',
            conditions: pricingData?.conditions || null,
            trends: pricingData?.trends || null,
            slab_pricing: slabData || [],
          }
        });
      }

      return res.json({
        success: true,
        results: matches.rows.map(c => ({
          name: c.name, set_id: c.set_id, set_name: c.set_name,
          local_id: c.local_id, image_url: c.image_url, rarity: c.rarity,
        })),
        message: `Found ${matches.rows.length} cards with number ${parsed.cardNumber}. Please select one.`
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
      // Fallback: maybe "set code" is actually a card number prefix (e.g. "SV 107" → SV107)
      const prefixedCard = parsed.setCode + parsed.cardNumber;
      const totalMatch = input.trim().match(/\/\s*[A-Za-z]*\s*(\d+)$/);
      const prefixedTotal = totalMatch ? parsed.setCode + totalMatch[1] : null;

      let pfQuery, pfParams;
      if (prefixedTotal) {
        pfQuery = `SELECT * FROM card_index WHERE UPPER(local_id) = UPPER($1)
                   AND set_id IN (SELECT set_id FROM card_index WHERE UPPER(local_id) = UPPER($2))
                   ORDER BY set_id`;
        pfParams = [prefixedCard, prefixedTotal];
      } else {
        pfQuery = 'SELECT * FROM card_index WHERE UPPER(local_id) = UPPER($1) ORDER BY set_id';
        pfParams = [prefixedCard];
      }
      const pfMatches = await pool.query(pfQuery, pfParams);

      if (pfMatches.rows.length === 1) {
        const match = pfMatches.rows[0];
        let pricingData = null;
        let slabData = [];
        try {
          pricingData = await getCardPricing(match.set_id, prefixedCard, match.name);
          slabData = await getSlabPricing(match.set_id, prefixedCard, match.name);
          if (pricingData) {
            savePriceHistory(match.set_id, prefixedCard, match.name, pricingData).catch(err =>
              console.error('[Vending] Price history save failed:', err)
            );
          }
        } catch (pricingErr) {
          console.error('[Vending Buy] Pricing error:', pricingErr.message);
        }

        const buyVendorId = req.isVendor ? req.user.id : null;
        const insertResult = await pool.query(
          `INSERT INTO vending_lookups (raw_input, set_code, card_number, card_name, set_name, set_id, image_url, market_price, currency, ip_address, type, vendor_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'buy', $11)
           RETURNING id`,
          [input.trim(), null, prefixedCard, match.name, match.set_name, match.set_id, match.image_url, pricingData?.marketPrice || null, pricingData?.currency || 'GBP', req.ip, buyVendorId]
        );

        return res.json({
          success: true,
          lookup: {
            id: insertResult.rows[0].id,
            card_name: match.name,
            set_name: match.set_name,
            set_id: match.set_id,
            card_number: prefixedCard,
            image_url: match.image_url,
            rarity: match.rarity,
            market_price: pricingData?.marketPrice || null,
            currency: pricingData?.currency || 'GBP',
            conditions: pricingData?.conditions || null,
            trends: pricingData?.trends || null,
            slab_pricing: slabData || [],
          }
        });
      }

      if (pfMatches.rows.length > 1) {
        return res.json({
          success: true,
          results: pfMatches.rows.map(c => ({
            name: c.name, set_id: c.set_id, set_name: c.set_name,
            local_id: c.local_id, image_url: c.image_url, rarity: c.rarity,
          })),
          message: `Found ${pfMatches.rows.length} cards with number ${prefixedCard}. Please select one.`
        });
      }

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
    let slabData = [];
    try {
      pricingData = await getCardPricing(setId, parsed.cardNumber, card.name);
      slabData = await getSlabPricing(setId, parsed.cardNumber, card.name);
      // Save price snapshot to history
      if (pricingData) {
        savePriceHistory(setId, parsed.cardNumber, card.name, pricingData).catch(err =>
          console.error('[Vending] Price history save failed:', err)
        );
      }
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
        slab_pricing: slabData || [],
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
    let slabData = [];
    try {
      pricingData = await getCardPricing(set_id, local_id, name);
      slabData = await getSlabPricing(set_id, local_id, name);
      // Save price snapshot to history
      if (pricingData) {
        savePriceHistory(set_id, local_id, name, pricingData).catch(err =>
          console.error('[Vending] Price history save failed:', err)
        );
      }
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
        slab_pricing: slabData || [],
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

// ADMIN: GET /api/vending/customers
// Returns distinct customers who provided contact info
router.get('/customers', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    const search = req.query.search || '';
    const vf = vendorFilter(req, search ? 2 : 1);

    let searchClause = '';
    const params = [];

    if (search) {
      searchClause = `AND (LOWER(customer_name) LIKE $1 OR LOWER(customer_email) LIKE $1 OR customer_phone LIKE $1)`;
      params.push(`%${search.toLowerCase()}%`);
    }

    const result = await pool.query(
      `SELECT
        customer_name,
        customer_email,
        customer_phone,
        COUNT(DISTINCT basket_id) as basket_count,
        COUNT(*) as card_count,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN sale_price ELSE 0 END), 0) as total_spent,
        MAX(created_at) as last_visit
       FROM vending_lookups
       WHERE customer_name IS NOT NULL
         ${searchClause}
         ${vf.clause}
       GROUP BY customer_name, customer_email, customer_phone
       ORDER BY last_visit DESC
       LIMIT 100`,
      [...params, ...vf.params]
    );

    res.json({ customers: result.rows });
  } catch (err) {
    console.error('[Vending] Customers error:', err);
    res.status(500).json({ error: 'Failed to load customers' });
  }
});

// ADMIN: GET /api/vending/analytics/best-movers
// Returns cards with biggest price gains over period
router.get('/analytics/best-movers', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7', 10);
    const limit = parseInt(req.query.limit || '20', 10);

    // Get cards with recent snapshots and calculate % change
    const result = await pool.query(
      `WITH latest AS (
        SELECT DISTINCT ON (set_id, card_number)
          set_id, card_number, card_name, market_price, snapshot_date
        FROM market_price_history
        WHERE snapshot_date >= CURRENT_DATE - $1::int
        ORDER BY set_id, card_number, snapshot_date DESC
      ),
      oldest AS (
        SELECT DISTINCT ON (set_id, card_number)
          set_id, card_number, market_price as old_price
        FROM market_price_history
        WHERE snapshot_date >= CURRENT_DATE - $1::int
        ORDER BY set_id, card_number, snapshot_date ASC
      )
      SELECT
        l.set_id,
        l.card_number,
        l.card_name,
        o.old_price,
        l.market_price as current_price,
        ROUND(((l.market_price - o.old_price) / NULLIF(o.old_price, 0) * 100)::numeric, 2) as percent_change
      FROM latest l
      JOIN oldest o ON l.set_id = o.set_id AND l.card_number = o.card_number
      WHERE o.old_price > 0 AND l.market_price > 0
      ORDER BY percent_change DESC NULLS LAST
      LIMIT $2`,
      [days, limit]
    );

    res.json({ movers: result.rows, period_days: days });
  } catch (err) {
    console.error('[Vending] Best movers error:', err);
    res.status(500).json({ error: 'Failed to load best movers' });
  }
});

// ADMIN: GET /api/vending/analytics/price-history/:setId/:cardNumber
// Returns price history for a specific card
router.get('/analytics/price-history/:setId/:cardNumber', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    const { setId, cardNumber } = req.params;
    const days = parseInt(req.query.days || '30', 10);

    const result = await pool.query(
      `SELECT
        snapshot_date,
        market_price,
        last_sold_price,
        last_sold_date,
        trend_7d_pct,
        trend_30d_pct
       FROM market_price_history
       WHERE set_id = $1 AND card_number = $2
         AND snapshot_date >= CURRENT_DATE - $3::int
       ORDER BY snapshot_date ASC`,
      [setId, cardNumber, days]
    );

    res.json({ history: result.rows });
  } catch (err) {
    console.error('[Vending] Price history error:', err);
    res.status(500).json({ error: 'Failed to load price history' });
  }
});

// ADMIN: GET /api/vending/analytics/trending
// Returns trending cards (most looked up + price changes)
router.get('/analytics/trending', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7', 10);
    const limit = parseInt(req.query.limit || '20', 10);

    // Count lookups and get latest price data
    const result = await pool.query(
      `WITH lookup_counts AS (
        SELECT
          set_id,
          card_number,
          card_name,
          COUNT(*) as lookup_count
        FROM vending_lookups
        WHERE created_at >= NOW() - ($1 || ' days')::interval
          AND set_id IS NOT NULL
          AND card_number IS NOT NULL
        GROUP BY set_id, card_number, card_name
      ),
      latest_prices AS (
        SELECT DISTINCT ON (set_id, card_number)
          set_id,
          card_number,
          market_price,
          trend_7d_pct
        FROM market_price_history
        WHERE snapshot_date >= CURRENT_DATE - $1::int
        ORDER BY set_id, card_number, snapshot_date DESC
      )
      SELECT
        lc.set_id,
        lc.card_number,
        lc.card_name,
        lc.lookup_count,
        lp.market_price,
        lp.trend_7d_pct
      FROM lookup_counts lc
      LEFT JOIN latest_prices lp ON lc.set_id = lp.set_id AND lc.card_number = lp.card_number
      ORDER BY lc.lookup_count DESC, lp.trend_7d_pct DESC NULLS LAST
      LIMIT $2`,
      [days, limit]
    );

    res.json({ trending: result.rows, period_days: days });
  } catch (err) {
    console.error('[Vending] Trending error:', err);
    res.status(500).json({ error: 'Failed to load trending cards' });
  }
});

// ADMIN: GET /api/vending/catalogue/stats
// Returns PokePulse catalogue cache statistics
router.get('/catalogue/stats', auth, requireVendorOrAdmin, async (req, res) => {
  try {
    const stats = await getCatalogueStats();
    res.json({ stats: stats || {} });
  } catch (err) {
    console.error('[Vending] Catalogue stats error:', err);
    res.status(500).json({ error: 'Failed to load catalogue stats' });
  }
});

module.exports = router;
