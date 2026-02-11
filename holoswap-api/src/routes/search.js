const { Router } = require('express');

const router = Router();

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

// GET /api/search?q=charizard
router.get('/', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.length < 2) {
      return res.json({ data: [] });
    }

    const cacheKey = query.toLowerCase().trim();

    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ data: cached });
    }

    // Use TCGdex API - free, fast, no key needed
    const url = `https://api.tcgdex.net/v2/en/cards?name=${encodeURIComponent(query)}&sort:field=name&sort:order=ASC`;
    const response = await fetch(url);
    const cards = await response.json();

    // TCGdex returns a flat list, transform to match our frontend format
    const results = (Array.isArray(cards) ? cards.slice(0, 20) : []).map(card => ({
      id: card.id,
      name: card.name,
      number: card.localId,
      rarity: card.rarity || '',
      set: { name: card.set?.name || '' },
      images: {
        small: card.image ? card.image + '/low.webp' : null,
      },
    }));

    cache.set(cacheKey, { data: results, time: Date.now() });

    res.json({ data: results });
  } catch (err) {
    console.error('Search proxy error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
