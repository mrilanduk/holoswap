// Daily PokePulse catalogue sync
// Run once a day — picks the next uncached set and imports it.
// Over time, builds a complete local catalogue.
//
// Usage:
//   node import-pokepulse.js            # Auto-pick next uncached set
//   node import-pokepulse.js sv01       # Import a specific set
//   node import-pokepulse.js --status   # Show cache coverage stats
//   node import-pokepulse.js --sets     # List available PokePulse sets
//   node import-pokepulse.js --discover  # Discover all PokePulse set IDs (pages full catalogue)
//
// Add to cron: 0 3 * * * cd /path/to/api && node src/import-pokepulse.js

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const BASE_URL = 'https://catalogueservicev2-production.up.railway.app/api';
const CATALOGUE_URL = `${BASE_URL}/cards/search`;
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

// Fetch available sets from PokePulse
async function fetchPokePulseSets() {
  const headers = { 'Content-Type': 'application/json', 'X-API-Key': API_KEY };

  // Try common endpoint patterns
  const endpoints = [
    `${BASE_URL}/sets`,
    `${BASE_URL}/cards/sets`,
    `${BASE_URL}/catalogue/sets`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data = await res.json();
        return { url, data };
      }
    } catch { /* try next */ }
  }

  // Fallback: search with no filters to see what set IDs exist in the catalogue
  console.log('   No sets endpoint found, probing catalogue search...\n');
  try {
    const res = await fetch(CATALOGUE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ limit: 100, excludeGraded: true })
    });
    if (res.ok) {
      const data = await res.json();
      return { url: CATALOGUE_URL, data, isSearchFallback: true };
    }
  } catch { /* ignore */ }

  return null;
}

// Discover ALL set IDs by paging through the full PokePulse catalogue
async function discoverSets() {
  console.log('🔍 Discovering all PokePulse set IDs...\n');
  const allSets = new Map();
  let page = 1;
  const pageSize = 1000;
  let totalPages = 1;

  while (page <= totalPages) {
    try {
      const res = await fetch(CATALOGUE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body: JSON.stringify({ page, page_size: pageSize }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();

      if (page === 1 && data.pagination) {
        totalPages = data.pagination.total_pages || Math.ceil((data.pagination.total || 0) / pageSize);
        console.log(`   ${data.pagination.total || '?'} total cards, ${totalPages} pages\n`);
      }

      const cards = extractCardsArray(data);
      for (const c of cards) {
        const sid = c.set_id || 'unknown';
        if (!allSets.has(sid)) {
          allSets.set(sid, { name: c.set_name || '', count: 0 });
        }
        allSets.get(sid).count++;
      }

      process.stdout.write(`   Page ${page}/${totalPages} — ${allSets.size} sets found so far\r`);
      page++;
      await delay(500);
    } catch (err) {
      console.error(`\n   ❌ Page ${page} error: ${err.message}`);
      if (err.message.includes('429')) {
        console.log('   Waiting 60s for rate limit...');
        await delay(60000);
      } else {
        page++;
      }
    }
  }

  console.log(`\n\n   ✅ Found ${allSets.size} sets:\n`);
  const sorted = [...allSets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [id, info] of sorted) {
    console.log(`   ${id.padEnd(20)} ${info.name.padEnd(35)} (${info.count} cards)`);
  }

  return sorted.map(([id]) => id);
}

async function showSets() {
  console.log('🔍 Fetching PokePulse sets...\n');

  const result = await fetchPokePulseSets();
  if (!result) {
    console.log('❌ Could not fetch sets from PokePulse');
    return;
  }

  console.log(`   Source: ${result.url}\n`);

  if (result.isSearchFallback) {
    // Extract unique set IDs from search results
    const cards = extractCardsArray(result.data);
    if (cards.length === 0) {
      console.log('   No cards returned from search');
      console.log(`   Raw response keys: ${JSON.stringify(Object.keys(result.data))}`);
      console.log(`   Raw (200 chars): ${JSON.stringify(result.data).substring(0, 200)}`);
      return;
    }
    const sets = new Map();
    for (const card of cards) {
      const sid = card.set_id || card.setId || 'unknown';
      if (!sets.has(sid)) {
        sets.set(sid, { name: card.set_name || card.setName || '', count: 0 });
      }
      sets.get(sid).count++;
    }
    console.log(`   Found ${sets.size} sets from ${cards.length} sample cards:\n`);
    for (const [id, info] of [...sets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`   ${id.padEnd(15)} ${info.name} (${info.count} sample cards)`);
    }
    console.log(`\n   ⚠️  This is from a limited sample — more sets likely exist`);
    console.log(`   First card keys: ${JSON.stringify(Object.keys(cards[0]))}`);
  } else {
    // Direct sets endpoint response
    const data = result.data;
    console.log(`   Response keys: ${JSON.stringify(Object.keys(data))}`);
    console.log(`   Raw (500 chars): ${JSON.stringify(data).substring(0, 500)}`);

    // Try to extract set list from common shapes
    const sets = Array.isArray(data) ? data
      : data.sets ? data.sets
      : data.data ? data.data
      : data.results ? data.results
      : null;

    if (sets && Array.isArray(sets)) {
      console.log(`\n   ${sets.length} sets found:\n`);
      for (const s of sets) {
        const id = s.set_id || s.setId || s.id || '?';
        const name = s.set_name || s.setName || s.name || '';
        const count = s.card_count || s.cardCount || s.total || '';
        console.log(`   ${String(id).padEnd(15)} ${name}${count ? ` (${count} cards)` : ''}`);
      }
    }
  }
}

// Show cache coverage for all sets
async function showStatus() {
  console.log('📊 PokePulse Catalogue Cache Status\n');

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

// Find the next set that needs caching
// Prioritises newer sets (SV > SWSH > SM > XY > base) and skips sets marked as unsupported
async function findNextSet() {
  const result = await pool.query(
    `SELECT ci.set_id, ci.set_name, ci.card_count as index_cards,
       COALESCE(pp.cached, 0) as cached_cards,
       CASE
         WHEN ci.set_id LIKE 'sv%' THEN 1
         WHEN ci.set_id LIKE 'swsh%' THEN 2
         WHEN ci.set_id LIKE 'sm%' THEN 3
         WHEN ci.set_id LIKE 'xy%' THEN 4
         ELSE 5
       END as era_priority
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
       AND NOT EXISTS (
         SELECT 1 FROM pokepulse_catalogue sk
         WHERE sk.set_id = (
           CASE
             WHEN ci.set_id LIKE '%.' || '%' THEN
               regexp_replace(split_part(ci.set_id, '.', 1), '(\\D+)0*(\\d+)', '\\1\\2') || 'pt' || split_part(ci.set_id, '.', 2)
             ELSE regexp_replace(ci.set_id, '(\\D+)0*(\\d+)', '\\1\\2')
           END
         ) AND sk.product_id LIKE 'SKIP_%'
       )
     ORDER BY era_priority ASC, COALESCE(pp.cached, 0) ASC, ci.card_count DESC
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
  let emptyResponses = 0;
  const searchedNames = new Set();

  const totalNames = new Set(cardsResult.rows.map(c => c.name)).size;

  for (const card of cardsResult.rows) {
    if (searchedNames.has(card.name)) continue;
    searchedNames.add(card.name);

    const progress = `[${searchedNames.size}/${totalNames}]`;

    try {
      const catalogueData = await searchCatalogue(ppSetId, card.name);
      apiCalls++;
      const cards = extractCardsArray(catalogueData);

      // Debug: show raw response shape for the first card
      if (searchedNames.size === 1) {
        console.log(`   🔍 Debug — API response keys: ${JSON.stringify(Object.keys(catalogueData))}`);
        console.log(`   🔍 Debug — ${cards.length} cards returned`);
        if (cards.length > 0) {
          console.log(`   🔍 Debug — First card keys: ${JSON.stringify(Object.keys(cards[0]))}`);
          console.log(`   🔍 Debug — First card product_id: ${cards[0].product_id || 'MISSING'}`);
        } else {
          console.log(`   🔍 Debug — Raw response (first 200 chars): ${JSON.stringify(catalogueData).substring(0, 200)}`);
        }
        console.log('');
      }

      if (cards.length === 0) emptyResponses++;

      let batchCached = 0;
      for (const c of cards) {
        const ok = await cacheCard(c, ppSetId);
        if (ok) { cached++; batchCached++; }
      }

      process.stdout.write(`   ${progress} ${card.name} — ${batchCached} cached (${cards.length} results)\r`);

      // Rate limit: 1 request per second
      await delay(1000);

    } catch (err) {
      process.stdout.write(`   ${progress} ${card.name} — ERROR\r`);
      errors++;
      if (err.message.includes('429')) {
        console.log(`   ⚠️  Rate limited, waiting 60s...`);
        await delay(60000);
      } else {
        console.log(`   ❌ ${card.name}: ${err.message}`);
      }
    }
  }

  console.log(`\n   ✅ Done — ${cached} products cached, ${apiCalls} API calls, ${errors} errors`);
  if (emptyResponses > 0) {
    console.log(`   ⚠️  ${emptyResponses}/${apiCalls} calls returned no results — PokePulse may not cover set "${ppSetId}"`);
  }

  // If zero products cached after trying, mark set as unsupported so auto-pick skips it
  if (cached === 0 && apiCalls >= 5) {
    try {
      await pool.query(
        `INSERT INTO pokepulse_catalogue (product_id, set_id, card_name, last_fetched)
         VALUES ($1, $2, 'UNSUPPORTED_SET', NOW())
         ON CONFLICT (product_id) DO NOTHING`,
        [`SKIP_${ppSetId}`, ppSetId]
      );
      console.log(`   🚫 Marked "${ppSetId}" as unsupported — will be skipped in auto-pick`);
    } catch { /* ignore */ }
  }

  return { cached, apiCalls, errors };
}

async function run() {
  const args = process.argv.slice(2);

  // Discover mode — page through full catalogue to find all set IDs
  if (args.includes('--discover')) {
    await discoverSets();
    await pool.end();
    return;
  }

  // Sets mode — list available PokePulse sets
  if (args.includes('--sets')) {
    await showSets();
    await pool.end();
    return;
  }

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
