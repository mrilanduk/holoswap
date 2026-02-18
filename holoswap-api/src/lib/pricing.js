// Shared PokePulse pricing functions
// Used by both /api/pricing and /api/vending routes

const pool = require('../db');

// Cache management
const catalogueCache = new Map();
const marketDataCache = new Map();

const CATALOGUE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const MARKET_DATA_TTL = 15 * 60 * 1000;   // 15 minutes

// Rate limiting
let apiCallCount = 0;
let lastResetDate = new Date().toDateString();

function getCached(cache, key, ttl) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > ttl) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(cache, key, data) {
  cache.set(key, { data, time: Date.now() });
}

function checkRateLimit() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    apiCallCount = 0;
    lastResetDate = today;
  }

  if (apiCallCount >= 1000) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const err = new Error('Daily API limit reached. Please try again tomorrow.');
    err.status = 429;
    err.retryAfter = tomorrow.toISOString();
    throw err;
  }

  apiCallCount++;
  console.log(`PokePulse API calls today: ${apiCallCount}/1000`);
}

// Convert TCGDex set ID to PokePulse format
// sv03.5 → sv3pt5, me02.5 → me2pt5, sv01 → sv1
const POKEPULSE_SET_OVERRIDES = {
  'me01': 'm1',
};

function convertSetIdToPokePulse(tcgdexSetId) {
  if (POKEPULSE_SET_OVERRIDES[tcgdexSetId]) return POKEPULSE_SET_OVERRIDES[tcgdexSetId];
  if (tcgdexSetId.includes('.')) {
    const parts = tcgdexSetId.split('.');
    const prefix = parts[0].replace(/(\D+)0*(\d+)/, '$1$2');
    return `${prefix}pt${parts[1]}`;
  }
  return tcgdexSetId.replace(/(\D+)0*(\d+)/, '$1$2');
}

// Search PokePulse catalogue for card
async function searchCatalogue(pokePulseSetId, cardName) {
  const url = 'https://catalogueservicev2-production.up.railway.app/api/cards/search';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.POKEPULSE_CATALOGUE_KEY
    },
    body: JSON.stringify({
      ...(pokePulseSetId && { setId: pokePulseSetId }),
      cardName: cardName,
      excludeGraded: true,
      limit: 10
    })
  });

  if (!response.ok) {
    throw new Error(`Catalogue API error: ${response.status}`);
  }

  return response.json();
}

// Get market data from PokePulse
async function getMarketData(productIdOrIds) {
  const url = 'https://marketdataapi-production.up.railway.app/api/market-data/batch';
  const ids = Array.isArray(productIdOrIds) ? productIdOrIds : [productIdOrIds];

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.POKEPULSE_MARKET_KEY
    },
    body: JSON.stringify({
      productIds: ids
    })
  });

  if (!response.ok) {
    throw new Error(`Market Data API error: ${response.status}`);
  }

  return response.json();
}

// Find matching card from catalogue results
// Match card number, stripping leading zeros and ignoring /total suffix
// e.g. "79" matches "079/073", "79" matches "079", "79" matches "79/073"
function matchCardNumber(catalogueNum, searchNum) {
  const catalogueBase = catalogueNum.split('/')[0].replace(/^0+/, '') || '0';
  const searchBase = searchNum.replace(/^0+/, '') || '0';
  return catalogueBase === searchBase;
}

function findMatchingCard(catalogueResults, cardNumber) {
  console.log(`Finding match for card number "${cardNumber}" among ${catalogueResults.length} results`);
  const materials = catalogueResults.map(c => ({ name: c.card_name || c.name, num: c.card_number, material: c.material }));
  console.log(`Card materials: ${JSON.stringify(materials)}`);

  // Accept raw cards (material null, undefined, or empty string)
  const rawCards = catalogueResults.filter(card => !card.material);
  console.log(`${rawCards.length} raw (non-graded) cards found`);

  if (rawCards.length === 0) {
    // If all cards are graded/material, use them anyway as fallback
    console.log(`No raw cards found, using all ${catalogueResults.length} cards as fallback`);
    const allMatches = catalogueResults.filter(card =>
      card.card_number && matchCardNumber(card.card_number, cardNumber)
    );
    if (allMatches.length > 0) return allMatches[0];
    if (catalogueResults.length === 1) return catalogueResults[0];
    return null;
  }

  if (rawCards.length > 0) {
    const cardNumbers = rawCards.map(c => c.card_number).slice(0, 5);
    console.log(`Sample card numbers: ${cardNumbers.join(', ')}`);
  }

  const exactMatches = rawCards.filter(card =>
    card.card_number && matchCardNumber(card.card_number, cardNumber)
  );

  if (exactMatches.length > 0) {
    console.log(`Found ${exactMatches.length} exact number match(es), using: ${exactMatches[0].card_number}`);
    return exactMatches[0];
  }

  if (rawCards.length === 1) {
    console.log(`Only one raw card found, using despite number mismatch: ${rawCards[0].card_number}`);
    return rawCards[0];
  }

  console.log(`Multiple raw cards (${rawCards.length}) but no card number match for "${cardNumber}"`);
  return null;
}

// Extract cards array from catalogue response
function extractCardsArray(catalogueData) {
  if (Array.isArray(catalogueData)) return catalogueData;
  if (catalogueData.cards && Array.isArray(catalogueData.cards)) return catalogueData.cards;
  if (catalogueData.data && Array.isArray(catalogueData.data)) return catalogueData.data;
  if (catalogueData.results && Array.isArray(catalogueData.results)) return catalogueData.results;
  return null;
}

// Extract pricing records from market data response
function extractPricingRecords(marketData, productId) {
  if (marketData.data && marketData.data[productId]) return marketData.data[productId];
  if (marketData[productId]) return marketData[productId];
  if (Array.isArray(marketData)) return marketData;
  return [];
}

// Build formatted pricing data from records
function formatPricingData(pricingRecords, productId, cached) {
  const conditions = {};
  let marketPrice = 0;
  let currency = 'GBP';
  let trendsData = null;
  let lastSoldPrice = null;
  let lastSoldDate = null;

  pricingRecords.forEach(record => {
    const condition = record.condition?.toUpperCase() || 'UNKNOWN';
    const value = parseFloat(record.value) || 0;

    const conditionMap = {
      'NM': 'Near Mint',
      'LP': 'Lightly Played',
      'MP': 'Moderately Played',
      'HP': 'Heavily Played',
      'DMG': 'Damaged'
    };

    const displayCondition = conditionMap[condition] || condition;

    conditions[displayCondition] = {
      low: value * 0.9,
      market: value,
      high: value * 1.1
    };

    if (condition === 'NM') {
      marketPrice = value;
      currency = record.currency === '£' ? 'GBP' : record.currency;
      lastSoldPrice = record.last_sold_price || null;
      lastSoldDate = record.last_sold_date || null;

      if (record.trends) {
        trendsData = {
          '1day': {
            percentage: record.trends['1d']?.percentage_change || 0,
            previous: record.trends['1d']?.previous_value || 0
          },
          '7day': {
            percentage: record.trends['7d']?.percentage_change || 0,
            previous: record.trends['7d']?.previous_value || 0
          },
          '30day': {
            percentage: record.trends['30d']?.percentage_change || 0,
            previous: record.trends['30d']?.previous_value || 0
          }
        };
      }
    }
  });

  return {
    productId,
    marketPrice,
    currency,
    conditions,
    trends: trendsData,
    lastSoldPrice,
    lastSoldDate,
    lastUpdated: new Date().toISOString(),
    cached
  };
}

// Analyze market data and recommend buy strategy
function analyzeBuyRecommendation(pricingData) {
  if (!pricingData) {
    return {
      isHotBuy: false,
      confidence: 'low',
      recommendedPercentage: 50,
      reasoning: 'No market data available'
    };
  }

  let score = 0;
  const reasons = [];

  // Factor 1: Last sold date (recency = demand)
  if (pricingData.lastSoldDate) {
    const daysSinceLastSale = (Date.now() - new Date(pricingData.lastSoldDate)) / (1000 * 60 * 60 * 24);
    if (daysSinceLastSale < 3) {
      score += 20;
      reasons.push('Sold within last 3 days (high demand)');
    } else if (daysSinceLastSale < 7) {
      score += 15;
      reasons.push('Sold within last week');
    } else if (daysSinceLastSale < 14) {
      score += 10;
      reasons.push('Recent market activity');
    } else if (daysSinceLastSale > 30) {
      score -= 10;
      reasons.push('No recent sales (30+ days)');
    }
  } else {
    score -= 5;
    reasons.push('No recent sale data');
  }

  // Factor 2: 7-day price trend
  if (pricingData.trends?.['7day']) {
    const trend7d = pricingData.trends['7day'].percentage;
    if (trend7d > 15) {
      score += 25;
      reasons.push(`Strong 7d uptrend (+${trend7d.toFixed(1)}%)`);
    } else if (trend7d > 5) {
      score += 15;
      reasons.push(`Moderate 7d uptrend (+${trend7d.toFixed(1)}%)`);
    } else if (trend7d > 0) {
      score += 5;
      reasons.push(`Slight 7d uptrend (+${trend7d.toFixed(1)}%)`);
    } else if (trend7d < -15) {
      score -= 20;
      reasons.push(`Strong 7d downtrend (${trend7d.toFixed(1)}%)`);
    } else if (trend7d < -5) {
      score -= 10;
      reasons.push(`Moderate 7d downtrend (${trend7d.toFixed(1)}%)`);
    }
  }

  // Factor 3: 30-day price trend (context)
  if (pricingData.trends?.['30day']) {
    const trend30d = pricingData.trends['30day'].percentage;
    if (trend30d > 20) {
      score += 15;
      reasons.push(`Strong 30d uptrend (+${trend30d.toFixed(1)}%)`);
    } else if (trend30d < -20) {
      score -= 15;
      reasons.push(`Strong 30d downtrend (${trend30d.toFixed(1)}%)`);
    }
  }

  // Calculate recommendation
  let isHotBuy = score >= 30;
  let confidence = score >= 40 ? 'high' : score >= 20 ? 'medium' : 'low';
  let recommendedPercentage = 50; // base

  if (score >= 40) {
    recommendedPercentage = 75; // hot card, pay more
  } else if (score >= 25) {
    recommendedPercentage = 70;
  } else if (score >= 15) {
    recommendedPercentage = 65;
  } else if (score >= 5) {
    recommendedPercentage = 60;
  } else if (score >= -5) {
    recommendedPercentage = 55;
  } else if (score >= -15) {
    recommendedPercentage = 50;
  } else {
    recommendedPercentage = 45; // risky card, low offer
  }

  return {
    isHotBuy,
    confidence,
    recommendedPercentage,
    reasoning: reasons.join('. '),
    score
  };
}

// ============================================================
// PokePulse catalogue DB cache
// Stores product_id mappings so we can skip catalogue API calls
// ============================================================

// Look up cached product_id from DB
async function findCachedProduct(pokePulseSetId, cardNumber) {
  try {
    const result = await pool.query(
      `SELECT product_id, card_name, card_number, image_url
       FROM pokepulse_catalogue
       WHERE set_id = $1 AND card_number = $2 AND material IS NULL
       LIMIT 1`,
      [pokePulseSetId, cardNumber]
    );
    if (result.rows.length > 0) {
      console.log(`[PP Cache] HIT: ${pokePulseSetId} #${cardNumber} → ${result.rows[0].product_id}`);
      return result.rows[0];
    }
    // Try with card_number starting with the number (e.g., "89" matches "89/123")
    const fuzzy = await pool.query(
      `SELECT product_id, card_name, card_number, image_url
       FROM pokepulse_catalogue
       WHERE set_id = $1 AND card_number LIKE $2 AND material IS NULL
       LIMIT 1`,
      [pokePulseSetId, cardNumber + '%']
    );
    if (fuzzy.rows.length > 0) {
      console.log(`[PP Cache] FUZZY HIT: ${pokePulseSetId} #${cardNumber} → ${fuzzy.rows[0].product_id}`);
      return fuzzy.rows[0];
    }
    console.log(`[PP Cache] MISS: ${pokePulseSetId} #${cardNumber}`);
    return null;
  } catch (err) {
    console.error('[PP Cache] Lookup error:', err.message);
    return null;
  }
}

// Cache catalogue results to DB (upserts all cards from a search)
async function cacheCatalogueResults(pokePulseSetId, cardsArray) {
  if (!cardsArray || cardsArray.length === 0) return;

  let cached = 0;
  for (const card of cardsArray) {
    if (!card.product_id) continue;
    try {
      await pool.query(
        `INSERT INTO pokepulse_catalogue (product_id, set_id, card_number, card_name, material, image_url, last_fetched)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (product_id) DO UPDATE SET
           card_name = EXCLUDED.card_name,
           image_url = COALESCE(EXCLUDED.image_url, pokepulse_catalogue.image_url),
           last_fetched = NOW()`,
        [
          card.product_id,
          pokePulseSetId || card.set_id || null,
          card.card_number || null,
          card.card_name || card.name || null,
          card.material || null,
          card.image_url || card.image || null
        ]
      );
      cached++;
    } catch (err) {
      // Skip duplicates / errors silently
    }
  }
  if (cached > 0) {
    console.log(`[PP Cache] Saved ${cached} products for set ${pokePulseSetId || 'unknown'}`);
  }
}

// Get catalogue stats
async function getCatalogueStats() {
  try {
    const result = await pool.query(
      `SELECT
        COUNT(*) as total_products,
        COUNT(DISTINCT set_id) as total_sets,
        COUNT(*) FILTER (WHERE material IS NULL) as raw_cards,
        MIN(last_fetched) as oldest_entry,
        MAX(last_fetched) as newest_entry
       FROM pokepulse_catalogue`
    );
    return result.rows[0];
  } catch (err) {
    console.error('[PP Cache] Stats error:', err.message);
    return null;
  }
}

// Save price snapshot to history table (upserts once per day per card)
async function savePriceHistory(setId, cardNumber, cardName, pricingData) {
  if (!pricingData || !setId || !cardNumber) return;

  try {
    await pool.query(
      `INSERT INTO market_price_history
        (set_id, card_number, card_name, market_price, last_sold_price, last_sold_date, trend_7d_pct, trend_30d_pct, snapshot_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_DATE)
       ON CONFLICT (set_id, card_number, snapshot_date)
       DO UPDATE SET
         market_price = EXCLUDED.market_price,
         last_sold_price = EXCLUDED.last_sold_price,
         last_sold_date = EXCLUDED.last_sold_date,
         trend_7d_pct = EXCLUDED.trend_7d_pct,
         trend_30d_pct = EXCLUDED.trend_30d_pct,
         card_name = EXCLUDED.card_name`,
      [
        setId,
        cardNumber,
        cardName,
        pricingData.marketPrice || null,
        pricingData.lastSoldPrice || null,
        pricingData.lastSoldDate || null,
        pricingData.trends?.['7day']?.percentage || null,
        pricingData.trends?.['30day']?.percentage || null
      ]
    );
  } catch (err) {
    console.error('[Pricing] Failed to save price history:', err.message);
  }
}

module.exports = {
  catalogueCache,
  marketDataCache,
  CATALOGUE_TTL,
  MARKET_DATA_TTL,
  getCached,
  setCache,
  checkRateLimit,
  convertSetIdToPokePulse,
  searchCatalogue,
  getMarketData,
  findMatchingCard,
  matchCardNumber,
  extractCardsArray,
  extractPricingRecords,
  formatPricingData,
  analyzeBuyRecommendation,
  savePriceHistory,
  findCachedProduct,
  cacheCatalogueResults,
  getCatalogueStats,
};
