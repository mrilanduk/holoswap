// Shared PokePulse pricing functions
// Used by both /api/pricing and /api/vending routes

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

  const rawCards = catalogueResults.filter(card => card.material === null);
  console.log(`${rawCards.length} raw (non-graded) cards found`);

  if (rawCards.length === 0) {
    console.log(`No raw cards found after filtering`);
    return null;
  }

  if (rawCards.length > 0) {
    const cardNumbers = rawCards.map(c => c.card_number).slice(0, 5);
    console.log(`Sample card numbers: ${cardNumbers.join(', ')}`);
  }

  const exactMatches = rawCards.filter(card =>
    card.card_number && card.card_number.startsWith(cardNumber)
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

  return {
    productId,
    marketPrice,
    currency,
    conditions,
    trends: trendsData,
    lastUpdated: new Date().toISOString(),
    cached
  };
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
  extractCardsArray,
  extractPricingRecords,
  formatPricingData
};
