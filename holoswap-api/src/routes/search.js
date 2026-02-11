const { Router } = require('express');

const router = Router();

// Simple in-memory cache (clears after 1 hour)
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

// GET /api/search?q=charizard — proxy to PokemonTCG API with caching
router.get('/', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.length < 2) {
      return res.json({ data: [] });
    }

    const cacheKey = query.toLowerCase().trim();

    // Check cache first
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ data: cached });
    }

    const url = `https://api.pokemontcg.io/v2/cards?q=name:"${query}*"&pageSize=12&select=id,name,images,set,rarity,number`;
    const response = await fetch(url);
    const data = await response.json();
    const results = data.data || [];

    // Cache the results
    cache.set(cacheKey, { data: results, time: Date.now() });

    res.json({ data: results });
  } catch (err) {
    console.error('Search proxy error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
