const { Router } = require('express');
const auth = require('../middleware/auth');

const router = Router();

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
function convertSetIdToPokePulse(tcgdexSetId) {
  if (tcgdexSetId.includes('.')) {
    const parts = tcgdexSetId.split('.');
    // Remove leading zeros from number part
    const prefix = parts[0].replace(/(\D+)0*(\d+)/, '$1$2');
    return `${prefix}pt${parts[1]}`;
  }
  // Remove leading zeros from regular sets
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
      setId: pokePulseSetId,
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
async function getMarketData(productId) {
  const url = 'https://marketdataapi-production.up.railway.app/api/market-data/batch';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.POKEPULSE_MARKET_KEY
    },
    body: JSON.stringify({
      productIds: [productId]
    })
  });

  if (!response.ok) {
    throw new Error(`Market Data API error: ${response.status}`);
  }

  return response.json();
}

// Find matching card from catalogue results
function findMatchingCard(catalogueResults, cardNumber) {
  console.log(`Finding match for card number "${cardNumber}" among ${catalogueResults.length} results`);

  // Filter for raw cards only (not graded)
  const rawCards = catalogueResults.filter(card => card.material === null);
  console.log(`${rawCards.length} raw (non-graded) cards found`);

  if (rawCards.length > 0) {
    const cardNumbers = rawCards.map(c => c.card_number).slice(0, 5);
    console.log(`Sample card numbers: ${cardNumbers.join(', ')}`);
  }

  // Match card number prefix
  const matches = rawCards.filter(card =>
    card.card_number && card.card_number.startsWith(cardNumber)
  );

  if (matches.length === 0) {
    console.log(`No matches found for card number starting with "${cardNumber}"`);
    return null;
  }

  console.log(`Found ${matches.length} matching card(s), using first match: ${matches[0].card_number}`);
  return matches[0];
}

// GET /api/pricing/check?setId=sv03.5&number=199&name=Charizard ex
router.get('/check', auth, async (req, res) => {
  try {
    const { setId, number, name } = req.query;

    // Validate parameters
    if (!setId || !number || !name) {
      return res.status(400).json({
        error: 'Missing required parameters: setId, number, name'
      });
    }

    // Convert set ID
    const pokePulseSetId = convertSetIdToPokePulse(setId);
    console.log(`Converting setId: ${setId} → ${pokePulseSetId}`);

    // Check catalogue cache
    const catalogueCacheKey = `catalogue:${pokePulseSetId}:${name}`;
    let catalogueData = getCached(catalogueCache, catalogueCacheKey, CATALOGUE_TTL);

    if (!catalogueData) {
      // Cache miss - call API
      checkRateLimit();
      console.log(`Catalogue cache miss: ${catalogueCacheKey}`);
      catalogueData = await searchCatalogue(pokePulseSetId, name);
      setCache(catalogueCache, catalogueCacheKey, catalogueData);
    } else {
      console.log(`Catalogue cache hit: ${catalogueCacheKey}`);
    }

    // Extract cards array from response (handle different possible structures)
    let cardsArray = catalogueData;
    if (Array.isArray(catalogueData)) {
      cardsArray = catalogueData;
    } else if (catalogueData.cards && Array.isArray(catalogueData.cards)) {
      cardsArray = catalogueData.cards;
    } else if (catalogueData.data && Array.isArray(catalogueData.data)) {
      cardsArray = catalogueData.data;
    } else if (catalogueData.results && Array.isArray(catalogueData.results)) {
      cardsArray = catalogueData.results;
    } else {
      console.error('Unexpected catalogue response structure:', JSON.stringify(catalogueData).substring(0, 200));
      return res.json({
        success: true,
        data: null,
        message: 'No pricing data found for this card'
      });
    }

    console.log(`Catalogue returned ${cardsArray.length} cards for "${name}" in set ${pokePulseSetId}`);

    // Find matching card
    const matchingCard = findMatchingCard(cardsArray, number);

    if (!matchingCard) {
      return res.json({
        success: true,
        data: null,
        message: 'No pricing data found for this card'
      });
    }

    const productId = matchingCard.product_id;
    console.log(`Found product_id: ${productId}`);

    // Check market data cache
    const marketCacheKey = `market:${productId}`;
    let marketData = getCached(marketDataCache, marketCacheKey, MARKET_DATA_TTL);
    let cached = true;

    if (!marketData) {
      // Cache miss - call API
      checkRateLimit();
      console.log(`Market data cache miss: ${marketCacheKey}`);
      marketData = await getMarketData(productId);
      console.log(`Market data response structure:`, JSON.stringify(marketData).substring(0, 300));
      setCache(marketDataCache, marketCacheKey, marketData);
      cached = false;
    } else {
      console.log(`Market data cache hit: ${marketCacheKey}`);
    }

    // Extract pricing records array from response
    let pricingRecords = [];
    if (marketData.data && marketData.data[productId]) {
      pricingRecords = marketData.data[productId];
      console.log(`Extracted ${pricingRecords.length} pricing records from data wrapper`);
    } else if (marketData[productId]) {
      pricingRecords = marketData[productId];
      console.log(`Extracted ${pricingRecords.length} pricing records from direct key`);
    } else if (Array.isArray(marketData)) {
      pricingRecords = marketData;
      console.log(`Using response as direct array (${pricingRecords.length} records)`);
    }

    if (!pricingRecords || pricingRecords.length === 0) {
      console.log(`No pricing records found`);
      return res.json({
        success: true,
        data: null,
        message: 'No pricing data found for this card'
      });
    }

    // Build conditions object and find overall market price (NM condition)
    const conditions = {};
    let marketPrice = 0;
    let currency = 'GBP';
    let trendsData = null;

    pricingRecords.forEach(record => {
      const condition = record.condition?.toUpperCase() || 'UNKNOWN';
      const value = parseFloat(record.value) || 0;

      // Map condition to display name
      const conditionMap = {
        'NM': 'Near Mint',
        'LP': 'Lightly Played',
        'MP': 'Moderately Played',
        'HP': 'Heavily Played',
        'DMG': 'Damaged'
      };

      const displayCondition = conditionMap[condition] || condition;

      // For now, use the value as all three prices (low/market/high)
      // The API might provide these separately - adjust if available
      conditions[displayCondition] = {
        low: value * 0.9,   // Estimate 10% below market
        market: value,
        high: value * 1.1   // Estimate 10% above market
      };

      // Use NM price as overall market price
      if (condition === 'NM') {
        marketPrice = value;
        currency = record.currency === '£' ? 'GBP' : record.currency;

        // Extract trends from NM record
        if (record.trends) {
          trendsData = {
            '7day': {
              change: record.trends['7d']?.price_change || 0,
              percentage: record.trends['7d']?.percentage_change || 0
            },
            '30day': {
              change: record.trends['30d']?.price_change || 0,
              percentage: record.trends['30d']?.percentage_change || 0
            }
          };
        }
      }
    });

    // Format response
    const formattedData = {
      productId,
      marketPrice,
      currency,
      conditions,
      trends: trendsData,
      lastUpdated: new Date().toISOString(),
      cached
    };

    res.json({
      success: true,
      data: formattedData
    });

  } catch (err) {
    console.error('Pricing check error:', err);

    // Handle rate limit errors specifically
    if (err.status === 429) {
      return res.status(429).json({
        error: err.message,
        retryAfter: err.retryAfter
      });
    }

    res.status(500).json({ error: 'Failed to fetch pricing data' });
  }
});

module.exports = router;
