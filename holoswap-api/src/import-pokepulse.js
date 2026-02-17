// Bulk import PokePulse catalogue data
// Seeds the pokepulse_catalogue table by looking up cards from card_index
// against the PokePulse catalogue API.
//
// Usage: node import-pokepulse.js [setId] [--limit N]
//
// Examples:
//   node import-pokepulse.js          # Import all sets
//   node import-pokepulse.js sv01     # Import one set
//   node import-pokepulse.js --limit 5  # Import first 5 sets only
//
// Rate limited to ~2 requests/second to be nice to PokePulse API.

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const CATALOGUE_URL = 'https://catalogueservicev2-production.up.railway.app/api/cards/search';
const API_KEY = process.env.POKEPULSE_CATALOGUE_KEY;

if (!API_KEY) {
  console.error('Missing POKEPULSE_CATALOGUE_KEY in .env');
  process.exit(1);
}

// Convert TCGDex set ID to PokePulse format
function convertSetIdToPokePulse(tcgdexSetId) {
  if (tcgdexSetId.includes('.')) {
    const parts = tcgdexSetId.split('.');
    const prefix = parts[0].replace(/(\D+)0*(\d+)/, '$1$2');
    return `${prefix}pt${parts[1]}`;
  }
  return tcgdexSetId.replace(/(\D+)0*(\d+)/, '$1$2');
}

async function searchCatalogue(setId, cardName) {
  const response = await fetch(CATALOGUE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify({
      ...(setId && { setId }),
      cardName,
      excludeGraded: true,
      limit: 20
    })
  });

  if (!response.ok) {
    throw new Error(`Catalogue API error: ${response.status}`);
  }

  return response.json();
}

function extractCardsArray(data) {
  if (Array.isArray(data)) return data;
  if (data.cards && Array.isArray(data.cards)) return data.cards;
  if (data.data && Array.isArray(data.data)) return data.data;
  if (data.results && Array.isArray(data.results)) return data.results;
  return [];
}

async function cacheCard(card, setId) {
  if (!card.product_id) return false;
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
        setId || card.set_id || null,
        card.card_number || null,
        card.card_name || card.name || null,
        card.material || null,
        card.image_url || card.image || null
      ]
    );
    return true;
  } catch {
    return false;
  }
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  const args = process.argv.slice(2);
  const specificSet = args.find(a => !a.startsWith('--'));
  const limitArg = args.indexOf('--limit');
  const setLimit = limitArg !== -1 ? parseInt(args[limitArg + 1]) : null;

  console.log('🔄 PokePulse Catalogue Import\n');

  // Get existing cache stats
  const existingStats = await pool.query('SELECT COUNT(*) as count FROM pokepulse_catalogue');
  console.log(`📊 Existing cache: ${existingStats.rows[0].count} products\n`);

  // Get sets to process
  let setsQuery;
  if (specificSet) {
    setsQuery = await pool.query(
      'SELECT DISTINCT set_id, set_name, COUNT(*) as card_count FROM card_index WHERE set_id = $1 GROUP BY set_id, set_name',
      [specificSet]
    );
  } else {
    setsQuery = await pool.query(
      `SELECT DISTINCT set_id, set_name, COUNT(*) as card_count
       FROM card_index
       GROUP BY set_id, set_name
       ORDER BY set_id`
    );
  }

  let sets = setsQuery.rows;
  if (setLimit) sets = sets.slice(0, setLimit);

  console.log(`📋 Processing ${sets.length} set(s)\n`);

  let totalCached = 0;
  let totalSearched = 0;
  let totalErrors = 0;
  let apiCalls = 0;

  for (let i = 0; i < sets.length; i++) {
    const set = sets[i];
    const ppSetId = convertSetIdToPokePulse(set.set_id);

    // Get unique card names in this set
    const cardsResult = await pool.query(
      'SELECT DISTINCT name, local_id FROM card_index WHERE set_id = $1 ORDER BY local_id',
      [set.set_id]
    );

    // Check how many we already have cached for this set
    const cachedCount = await pool.query(
      'SELECT COUNT(*) FROM pokepulse_catalogue WHERE set_id = $1 AND material IS NULL',
      [ppSetId]
    );
    const already = parseInt(cachedCount.rows[0].count);

    console.log(`[${i + 1}/${sets.length}] ${set.set_name} (${set.set_id} → ${ppSetId})`);
    console.log(`   ${cardsResult.rows.length} cards in index, ${already} already cached`);

    if (already >= cardsResult.rows.length * 0.8) {
      console.log(`   ✅ Already mostly cached, skipping\n`);
      continue;
    }

    let setCached = 0;

    // Search by unique card names (batch approach)
    const searchedNames = new Set();
    for (const card of cardsResult.rows) {
      if (searchedNames.has(card.name)) continue;
      searchedNames.add(card.name);

      try {
        const catalogueData = await searchCatalogue(ppSetId, card.name);
        apiCalls++;
        const cards = extractCardsArray(catalogueData);

        for (const c of cards) {
          const success = await cacheCard(c, ppSetId);
          if (success) setCached++;
        }

        totalSearched++;

        // Rate limit: ~2 requests/second
        await delay(500);

      } catch (err) {
        totalErrors++;
        if (err.message.includes('429')) {
          console.log(`   ⚠️  Rate limited. Waiting 30s...`);
          await delay(30000);
        }
      }
    }

    totalCached += setCached;
    console.log(`   ✅ Cached ${setCached} products (${apiCalls} API calls total)\n`);
  }

  // Final stats
  const finalStats = await pool.query(
    `SELECT
      COUNT(*) as total,
      COUNT(DISTINCT set_id) as sets,
      COUNT(*) FILTER (WHERE material IS NULL) as raw_cards
     FROM pokepulse_catalogue`
  );

  console.log('════════════════════════════════════');
  console.log(`✅ Import complete!`);
  console.log(`   API calls: ${apiCalls}`);
  console.log(`   New products cached: ${totalCached}`);
  console.log(`   Errors: ${totalErrors}`);
  console.log(`   Total in cache: ${finalStats.rows[0].total} products (${finalStats.rows[0].sets} sets, ${finalStats.rows[0].raw_cards} raw cards)`);

  await pool.end();
}

run().catch(err => {
  console.error('❌ Import failed:', err);
  process.exit(1);
});
