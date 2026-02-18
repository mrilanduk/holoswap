const { Router } = require('express');
const auth = require('../middleware/auth');
const pool = require('../db');
const {
  catalogueCache, marketDataCache, CATALOGUE_TTL, MARKET_DATA_TTL,
  getCached, setCache, checkRateLimit,
  convertSetIdToPokePulse, searchCatalogue, getMarketData,
  findMatchingCard, extractCardsArray, extractPricingRecords, formatPricingData
} = require('../lib/pricing');

const router = Router();

// GET /api/pricing/check?setId=sv03.5&number=199&name=Charizard ex
router.get('/check', auth, async (req, res) => {
  try {
    const { setId, number, name } = req.query;

    if (!setId || !number || !name) {
      return res.status(400).json({
        error: 'Missing required parameters: setId, number, name'
      });
    }

    // Read pokepulse_set_id from card_index (no runtime conversion needed)
    const ppRow = await pool.query('SELECT pokepulse_set_id FROM card_index WHERE set_id = $1 AND pokepulse_set_id IS NOT NULL LIMIT 1', [setId]);
    const pokePulseSetId = ppRow.rows[0]?.pokepulse_set_id || convertSetIdToPokePulse(setId);
    console.log(`setId: ${setId} → pokepulse: ${pokePulseSetId}`);

    // Check catalogue cache
    const catalogueCacheKey = `catalogue:${pokePulseSetId}:${name}`;
    let catalogueData = getCached(catalogueCache, catalogueCacheKey, CATALOGUE_TTL);

    if (!catalogueData) {
      checkRateLimit();
      console.log(`Catalogue cache miss: ${catalogueCacheKey}`);
      catalogueData = await searchCatalogue(pokePulseSetId, name);
      setCache(catalogueCache, catalogueCacheKey, catalogueData);
    } else {
      console.log(`Catalogue cache hit: ${catalogueCacheKey}`);
    }

    const cardsArray = extractCardsArray(catalogueData);
    if (!cardsArray) {
      console.error('Unexpected catalogue response structure:', JSON.stringify(catalogueData).substring(0, 200));
      return res.json({ success: true, data: null, message: 'No pricing data found for this card' });
    }

    console.log(`Catalogue returned ${cardsArray.length} cards for "${name}" in set ${pokePulseSetId}`);

    const matchingCard = findMatchingCard(cardsArray, number);
    if (!matchingCard) {
      return res.json({ success: true, data: null, message: 'No pricing data found for this card' });
    }

    const productId = matchingCard.product_id;
    console.log(`Found product_id: ${productId}`);

    // Check market data cache
    const marketCacheKey = `market:${productId}`;
    let marketData = getCached(marketDataCache, marketCacheKey, MARKET_DATA_TTL);
    let cached = true;

    if (!marketData) {
      checkRateLimit();
      console.log(`Market data cache miss: ${marketCacheKey}`);
      marketData = await getMarketData(productId);
      console.log(`Market data response structure:`, JSON.stringify(marketData).substring(0, 300));
      setCache(marketDataCache, marketCacheKey, marketData);
      cached = false;
    } else {
      console.log(`Market data cache hit: ${marketCacheKey}`);
    }

    const pricingRecords = extractPricingRecords(marketData, productId);
    if (!pricingRecords || pricingRecords.length === 0) {
      console.log(`No pricing records found`);
      return res.json({ success: true, data: null, message: 'No pricing data found for this card' });
    }

    console.log(`Extracted ${pricingRecords.length} pricing records`);

    const formattedData = formatPricingData(pricingRecords, productId, cached);

    res.json({ success: true, data: formattedData });

  } catch (err) {
    console.error('Pricing check error:', err);

    if (err.status === 429) {
      return res.status(429).json({ error: err.message, retryAfter: err.retryAfter });
    }

    res.status(500).json({ error: 'Failed to fetch pricing data' });
  }
});

module.exports = router;
