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

function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
}

async function tcgFetch(path) {
  const res = await fetch(`https://api.tcgdex.net/v2/en${path}`);
  if (!res.ok) throw new Error(`TCGdex error: ${res.status}`);
  return res.json();
}

// GET /api/search?q=charizard — search cards by name
// GET /api/search?q=4/102 — search by card number
router.get('/', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.length < 1) {
      return res.json({ data: [] });
    }

    const cacheKey = 'search:' + query.toLowerCase().trim();
    const cached = getCached(cacheKey);
    if (cached) return res.json({ data: cached });

    let results = [];
    const setNumberMatch = query.match(/(\d+)\s*\/\s*(\d+)/);

    if (setNumberMatch) {
      const cardNumber = setNumberMatch[1];
      const namePart = query.replace(/\d+\s*\/\s*\d+/, '').trim();
      const cards = await tcgFetch(`/cards?localId=${cardNumber}`);
      let filtered = Array.isArray(cards) ? cards : [];
      if (namePart) {
        const nameLower = namePart.toLowerCase();
        filtered = filtered.filter(c => c.name && c.name.toLowerCase().includes(nameLower));
      }
      results = filtered.slice(0, 20);
    } else {
      const cards = await tcgFetch(`/cards?name=${encodeURIComponent(query)}&sort:field=name&sort:order=ASC`);
      results = (Array.isArray(cards) ? cards : []).slice(0, 20);
    }

    // Enrich with set names
    const setIds = [...new Set(results.map(c => {
      const parts = (c.id || '').split('-');
      parts.pop();
      return parts.join('-');
    }).filter(Boolean))];

    const setNames = {};
    await Promise.all(setIds.map(async (sid) => {
      const cachedSet = getCached('setname:' + sid);
      if (cachedSet) { setNames[sid] = cachedSet; return; }
      try {
        const data = await tcgFetch(`/sets/${sid}`);
        setNames[sid] = data.name || sid;
        setCache('setname:' + sid, data.name || sid);
      } catch { setNames[sid] = sid; }
    }));

    const formatted = results.map(card => {
      const parts = (card.id || '').split('-');
      const localId = parts.pop();
      const setId = parts.join('-');
      return {
        id: card.id,
        name: card.name,
        number: localId || card.localId,
        rarity: card.rarity || '',
        set: { name: setNames[setId] || '', id: setId },
        images: { small: card.image ? card.image + '/low.webp' : null },
      };
    });

    setCache(cacheKey, formatted);
    res.json({ data: formatted });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/search/sets — list all TCG sets
router.get('/sets', async (req, res) => {
  try {
    const cached = getCached('all-sets');
    if (cached) return res.json({ sets: cached });

    const sets = await tcgFetch('/sets');
    const sorted = (Array.isArray(sets) ? sets : []).sort((a, b) => a.name.localeCompare(b.name));

    setCache('all-sets', sorted);
    res.json({ sets: sorted });
  } catch (err) {
    console.error('Sets error:', err);
    res.status(500).json({ error: 'Failed to load sets' });
  }
});

// GET /api/search/sets/:id — get all cards in a set
router.get('/sets/:id', async (req, res) => {
  try {
    const setId = req.params.id;
    const cacheKey = 'set:' + setId;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await tcgFetch(`/sets/${setId}`);

    const result = {
      id: data.id,
      name: data.name,
      logo: data.logo ? data.logo + '.webp' : null,
      symbol: data.symbol ? data.symbol + '.webp' : null,
      cardCount: data.cardCount,
      cards: (data.cards || []).map(card => ({
        id: card.id,
        name: card.name,
        number: card.localId,
        image: card.image ? card.image + '/low.webp' : null,
      })),
    };

    setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Set detail error:', err);
    res.status(500).json({ error: 'Failed to load set' });
  }
});

// GET /api/search/card/:id — get full card detail
router.get('/card/:id', async (req, res) => {
  try {
    const cardId = req.params.id;
    const cacheKey = 'card:' + cardId;
    const cached = getCached(cacheKey);
    if (cached) return res.json({ card: cached });

    const card = await tcgFetch(`/cards/${cardId}`);

    setCache(cacheKey, card);
    res.json({ card });
  } catch (err) {
    console.error('Card detail error:', err);
    res.status(500).json({ error: 'Card not found' });
  }
});

module.exports = router;
