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

function formatCard(card) {
  return {
    id: card.id,
    name: card.name,
    number: card.localId,
    rarity: card.rarity || '',
    set: { name: card.set?.name || '' },
    images: {
      small: card.image ? card.image + '/low.webp' : null,
    },
  };
}

// GET /api/search?q=charizard
// GET /api/search?q=4/102
router.get('/', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.length < 1) {
      return res.json({ data: [] });
    }

    const cacheKey = query.toLowerCase().trim();

    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ data: cached });
    }

    let results = [];

    // Check for set number pattern like "4/102"
    const setNumberMatch = query.match(/(\d+)\s*\/\s*(\d+)/);

    if (setNumberMatch) {
      const cardNumber = setNumberMatch[1];
      const namePart = query.replace(/\d+\s*\/\s*\d+/, '').trim();

      // Search by card number
      const url = `https://api.tcgdex.net/v2/en/cards?localId=${cardNumber}`;
      const response = await fetch(url);
      const cards = await response.json();

      let filtered = Array.isArray(cards) ? cards : [];

      // If there's also a name, filter by it
      if (namePart) {
        const nameLower = namePart.toLowerCase();
        filtered = filtered.filter(c => c.name && c.name.toLowerCase().includes(nameLower));
      }

      results = filtered.slice(0, 20).map(formatCard);
    } else {
      // Regular name search
      const url = `https://api.tcgdex.net/v2/en/cards?name=${encodeURIComponent(query)}&sort:field=name&sort:order=ASC`;
      const response = await fetch(url);
      const cards = await response.json();

      results = (Array.isArray(cards) ? cards.slice(0, 20) : []).map(formatCard);
    }

    cache.set(cacheKey, { data: results, time: Date.now() });

    res.json({ data: results });
  } catch (err) {
    console.error('Search proxy error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
