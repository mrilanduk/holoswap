// Daily PokePulse catalogue sync
// Run once a day — picks the next uncached set and imports it.
// Over time, builds a complete local catalogue.
//
// Usage:
//   node import-pokepulse.js            # Auto-pick next uncached set
//   node import-pokepulse.js sv01       # Import a specific set
//   node import-pokepulse.js --status   # Show cache coverage stats
//
// Add to cron: 0 3 * * * cd /path/to/api && node src/import-pokepulse.js

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
  if (!response.ok) throw new Error(`Catalogue API error: ${response.status}`);
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

// Show cache coverage for all sets
async function showStatus() {
  console.log('📊 PokePulse Catalogue Cache Status\n');

  const setsResult = await pool.query(
    `SELECT ci.set_id, ci.set_name, COUNT(DISTINCT ci.name) as index_cards,
       COALESCE(pp.cached, 0) as cached_cards
     FROM card_index ci
     LEFT JOIN (
       SELECT set_id, COUNT(*) FILTER (WHERE material IS NULL) as cached
       FROM pokepulse_catalogue
       GROUP BY set_id
     ) pp ON pp.set_id = $1
     GROUP BY ci.set_id, ci.set_name, pp.cached
     ORDER BY ci.set_id`,
    ['dummy'] // placeholder — we'll fix the query
  );

  // Better query: get all sets with their cache coverage
  const result = await pool.query(
    `SELECT
       ci.set_id as tcgdex_id,
       ci.set_name,
       ci.card_count as index_cards,
       COALESCE(pp.cached, 0) as cached_cards
     FROM (
       SELECT set_id, set_name, COUNT(DISTINCT name) as card_count
       FROM card_index
       GROUP BY set_id, set_name
     ) ci
     LEFT JOIN (
       SELECT set_id, COUNT(*) FILTER (WHERE material IS NULL) as cached
       FROM pokepulse_catalogue
       GROUP BY set_id
     ) pp ON pp.set_id = (
       CASE
         WHEN ci.set_id LIKE '%.' || '%' THEN
           regexp_replace(split_part(ci.set_id, '.', 1), '(\\D+)0*(\\d+)', '\\1\\2') || 'pt' || split_part(ci.set_id, '.', 2)
         ELSE regexp_replace(ci.set_id, '(\\D+)0*(\\d+)', '\\1\\2')
       END
     )
     ORDER BY COALESCE(pp.cached, 0) ASC, ci.set_id`
  );

  let totalIndex = 0;
  let totalCached = 0;
  let uncachedSets = 0;

  for (const row of result.rows) {
    const pct = row.index_cards > 0 ? Math.round(row.cached_cards / row.index_cards * 100) : 0;
    const status = pct >= 80 ? '✅' : pct > 0 ? '🔶' : '❌';
    totalIndex += parseInt(row.index_cards);
    totalCached += parseInt(row.cached_cards);
    if (pct < 80) uncachedSets++;
    console.log(`  ${status} ${row.set_name} (${row.tcgdex_id}) — ${row.cached_cards}/${row.index_cards} (${pct}%)`);
  }

  console.log(`\n════════════════════════════════════`);
  console.log(`Total: ${totalCached}/${totalIndex} cards cached (${Math.round(totalCached / totalIndex * 100)}%)`);
  console.log(`Sets needing import: ${uncachedSets}`);
  console.log(`At 1 set/day, full coverage in ~${uncachedSets} days`);
}

// Find the next set that needs caching (least cached first)
async function findNextSet() {
  const result = await pool.query(
    `SELECT ci.set_id, ci.set_name, ci.card_count as index_cards,
       COALESCE(pp.cached, 0) as cached_cards
     FROM (
       SELECT set_id, set_name, COUNT(DISTINCT name) as card_count
       FROM card_index
       GROUP BY set_id, set_name
     ) ci
     LEFT JOIN (
       SELECT set_id, COUNT(*) FILTER (WHERE material IS NULL) as cached
       FROM pokepulse_catalogue
       GROUP BY set_id
     ) pp ON pp.set_id = (
       CASE
         WHEN ci.set_id LIKE '%.' || '%' THEN
           regexp_replace(split_part(ci.set_id, '.', 1), '(\\D+)0*(\\d+)', '\\1\\2') || 'pt' || split_part(ci.set_id, '.', 2)
         ELSE regexp_replace(ci.set_id, '(\\D+)0*(\\d+)', '\\1\\2')
       END
     )
     WHERE COALESCE(pp.cached, 0) < ci.card_count * 0.8
     ORDER BY COALESCE(pp.cached, 0) ASC, ci.card_count DESC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

// Import one set
async function importSet(tcgdexSetId) {
  const ppSetId = convertSetIdToPokePulse(tcgdexSetId);

  // Get cards from card_index
  const cardsResult = await pool.query(
    'SELECT DISTINCT name, local_id FROM card_index WHERE set_id = $1 ORDER BY local_id',
    [tcgdexSetId]
  );

  const setNameResult = await pool.query(
    'SELECT set_name FROM card_index WHERE set_id = $1 LIMIT 1',
    [tcgdexSetId]
  );
  const setName = setNameResult.rows[0]?.set_name || tcgdexSetId;

  // Check current cache
  const cachedCount = await pool.query(
    'SELECT COUNT(*) FROM pokepulse_catalogue WHERE set_id = $1 AND material IS NULL',
    [ppSetId]
  );
  const already = parseInt(cachedCount.rows[0].count);

  console.log(`\n📦 ${setName} (${tcgdexSetId} → ${ppSetId})`);
  console.log(`   ${cardsResult.rows.length} unique cards, ${already} already cached\n`);

  let cached = 0;
  let apiCalls = 0;
  let errors = 0;
  const searchedNames = new Set();

  for (const card of cardsResult.rows) {
    if (searchedNames.has(card.name)) continue;
    searchedNames.add(card.name);

    try {
      const catalogueData = await searchCatalogue(ppSetId, card.name);
      apiCalls++;
      const cards = extractCardsArray(catalogueData);

      for (const c of cards) {
        const ok = await cacheCard(c, ppSetId);
        if (ok) cached++;
      }

      // Rate limit: 1 request per second
      await delay(1000);

    } catch (err) {
      errors++;
      if (err.message.includes('429')) {
        console.log(`   ⚠️  Rate limited, waiting 60s...`);
        await delay(60000);
      } else {
        console.log(`   ❌ ${card.name}: ${err.message}`);
      }
    }
  }

  console.log(`   ✅ Done — ${cached} products cached, ${apiCalls} API calls, ${errors} errors`);
  return { cached, apiCalls, errors };
}

async function run() {
  const args = process.argv.slice(2);

  // Status mode
  if (args.includes('--status')) {
    await showStatus();
    await pool.end();
    return;
  }

  console.log('🔄 PokePulse Daily Sync\n');

  // Existing cache stats
  const stats = await pool.query(
    `SELECT COUNT(*) as total, COUNT(DISTINCT set_id) as sets
     FROM pokepulse_catalogue WHERE material IS NULL`
  );
  console.log(`📊 Cache: ${stats.rows[0].total} raw cards across ${stats.rows[0].sets} sets`);

  // Specific set or auto-pick
  const specificSet = args.find(a => !a.startsWith('--'));
  let targetSet;

  if (specificSet) {
    targetSet = { set_id: specificSet };
  } else {
    targetSet = await findNextSet();
    if (!targetSet) {
      console.log('\n✅ All sets are cached! Nothing to do.');
      await pool.end();
      return;
    }
  }

  const result = await importSet(targetSet.set_id);

  // Final stats
  const finalStats = await pool.query(
    `SELECT COUNT(*) as total, COUNT(DISTINCT set_id) as sets
     FROM pokepulse_catalogue WHERE material IS NULL`
  );
  console.log(`\n📊 Cache now: ${finalStats.rows[0].total} raw cards across ${finalStats.rows[0].sets} sets`);

  await pool.end();
}

run().catch(err => {
  console.error('❌ Failed:', err);
  process.exit(1);
});
