// Daily PokePulse catalogue sync
// Run once a day — picks the next uncached set and imports it.
// Over time, builds a complete local catalogue.
//
// Usage:
//   node import-pokepulse.js            # Auto-pick next uncached set
//   node import-pokepulse.js sv01       # Import a specific set
//   node import-pokepulse.js --status   # Show cache coverage stats
//   node import-pokepulse.js --sets     # List available PokePulse sets
//   node import-pokepulse.js --bulk      # Bulk-cache ALL vending sets (1-2 API calls per set)
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

// Must match POKEPULSE_SET_OVERRIDES in pricing.js
const POKEPULSE_SET_OVERRIDES = {
  'me01': 'm1', 'me02': 'me02', 'MEP': 'mep',
  'sv10.5w': 'rsv10pt5', 'sv10.5b': 'zsv10pt5',
  'swsh7.5': 'cel25', 'swsh10.5': 'pgo',
  'sm35': 'sm3pt5',
  'base1': 'bsu', 'base5': 'tr',
  '2021swsh': 'mcd21',
};

// Complete PokePulse set list (English sets only, sourced directly from PokePulse)
// This is the authoritative list — bulk import uses this, NOT card_index
const POKEPULSE_SETS = {
  // Scarlet & Violet era
  'sv1':       'Scarlet & Violet',
  'sv2':       'Paldea Evolved',
  'sv3':       'Obsidian Flames',
  'sv3pt5':    'Scarlet & Violet 151',
  'sv4':       'Paradox Rift',
  'sv4pt5':    'Paldean Fates',
  'sv5':       'Temporal Forces',
  'sv6':       'Twilight Masquerade',
  'sv6pt5':    'Shrouded Fable',
  'sv7':       'Stellar Crown',
  'sv8':       'Surging Sparks',
  'sv8pt5':    'Prismatic Evolutions',
  'sv9':       'Journey Together',
  'sv10':      'Destined Rivals',
  'rsv10pt5':  'White Flare',
  'zsv10pt5':  'Black Bolt',
  'svp':       'Scarlet & Violet Promos',
  'sve':       'Scarlet & Violet Energies',
  // Sword & Shield era
  'swsh1':     'Sword & Shield',
  'swsh2':     'Rebel Clash',
  'swsh3':     'Darkness Ablaze',
  'swsh3pt5':  'Champion\'s Path',
  'swsh4':     'Vivid Voltage',
  'swsh4pt5':  'Shining Fates',
  'swsh5':     'Battle Styles',
  'swsh6':     'Chilling Reign',
  'swsh7':     'Evolving Skies',
  'cel25':     'Celebrations',
  'swsh8':     'Fusion Strike',
  'swsh9':     'Brilliant Stars',
  'swsh9tg':   'Brilliant Stars (Trainer Gallery)',
  'swsh10':    'Astral Radiance',
  'pgo':       'Pokémon GO',
  'swsh11':    'Lost Origin',
  'swsh12':    'Silver Tempest',
  'swsh12pt5': 'Crown Zenith',
  'swshp':     'Sword & Shield Promos',
  // Sun & Moon era
  'sm1':       'Sun & Moon',
  'sm2':       'Guardians Rising',
  'sm3':       'Burning Shadows',
  'sm3pt5':    'Shining Legends',
  'sm4':       'Crimson Invasion',
  'sm5':       'Ultra Prism',
  'sm6':       'Forbidden Light',
  'sm7':       'Celestial Storm',
  'sm7pt5':    'Dragon Majesty',
  'sm8':       'Lost Thunder',
  'sm9':       'Team Up',
  'sm10':      'Unbroken Bonds',
  'sm11':      'Unified Minds',
  'sm11pt5':   'Hidden Fates',
  'sm12':      'Cosmic Eclipse',
  'sma':       'Hidden Fates (Shiny Vault)',
  'smp':       'Sun & Moon Promos',
  // XY era
  'xy0':       'Kalos Starter Set',
  'xy1':       'XY',
  'xy2':       'Flashfire',
  'xy3':       'Furious Fists',
  'xy4':       'Phantom Forces',
  'xy5':       'Primal Clash',
  'xy6':       'Roaring Skies',
  'xy7':       'Ancient Origins',
  'xy8':       'BREAKthrough',
  'xy9':       'BREAKpoint',
  'xy10':      'Fates Collide',
  'xy11':      'Steam Siege',
  'xy12':      'Evolutions',
  'xyp':       'XY Promos',
  'g1':        'Generations',
  'gen':       'Generations (Radiant Collection)',
  'dc1':       'Double Crisis',
  // Black & White era
  'bw1':       'Black & White',
  'bw2':       'Emerging Powers',
  'bw3':       'Noble Victories',
  'bw4':       'Next Destinies',
  'bw5':       'Dark Explorers',
  'bw6':       'Dragons Exalted',
  'bw7':       'Boundaries Crossed',
  'bw8':       'Plasma Storm',
  'bw9':       'Plasma Freeze',
  'bw10':      'Plasma Blast',
  'bw11':      'Legendary Treasures',
  'bwp':       'Black & White Promos',
  'dv1':       'Dragon Vault',
  'ltr':       'Legendary Treasures (Radiant Collection)',
  // HeartGold & SoulSilver era
  'hgss1':     'HeartGold & SoulSilver',
  'hgss2':     'Unleashed',
  'hgss3':     'Undaunted',
  'hgss4':     'Triumphant',
  'hsp':       'HeartGold & SoulSilver Promos',
  'col1':      'Call of Legends',
  // Diamond & Pearl / Platinum era
  'dp1':       'Diamond & Pearl',
  'dp2':       'Mysterious Treasures',
  'dp3':       'Secret Wonders',
  'dp4':       'Great Encounters',
  'dp5':       'Majestic Dawn',
  'dp6':       'Legends Awakened',
  'dp7':       'Stormfront',
  'dpp':       'Diamond & Pearl Promos',
  'pl1':       'Platinum',
  'pl2':       'Rising Rivals',
  'pl3':       'Supreme Victors',
  'pl4':       'Arceus',
  // EX era
  'ex1':       'EX Ruby & Sapphire',
  'ex2':       'EX Sandstorm',
  'ex3':       'EX Dragon',
  'ex4':       'EX Team Magma vs Team Aqua',
  'ex5':       'EX Hidden Legends',
  'ex6':       'EX FireRed & LeafGreen',
  'ex8':       'EX Deoxys',
  'ex9':       'EX Emerald',
  'ex10':      'EX Unseen Forces',
  'ex11':      'EX Delta Species',
  'ex12':      'EX Legend Maker',
  'ex13':      'EX Holon Phantoms',
  'ex14':      'EX Crystal Guardians',
  'ex15':      'EX Dragon Frontiers',
  'ex16':      'EX Power Keepers',
  // e-Card era
  'ecard1':    'Expedition Base Set',
  'ecard2':    'Aquapolis',
  'ecard3':    'Skyridge',
  // Base / Classic era
  'bsu':       'Base Set Unlimited',
  'bs1s':      'Base Set (1st Edition)',
  'bss':       'Base Set (Shadowless)',
  'base2':     'Jungle',
  'base3':     'Fossil',
  'base4':     'Base Set 2',
  'tr':        'Team Rocket',
  'base6':     'Legendary Collection',
  'basep':     'Wizards of the Coast Promos',
  'gym1':      'Gym Heroes',
  'gym2':      'Gym Challenge',
  'neo1':      'Neo Genesis',
  'neo2':      'Neo Discovery',
  'neo3':      'Neo Revelation',
  'neo4':      'Neo Destiny',
  'si':        'Southern Islands',
  // Mega Evolution
  'm1':        'Mega Evolution',
  'me02':      'Phantasmal Flames',
  'me2pt5':    'Ascended Heroes',
  'me3':       'Perfect Order',
  'mep':       'Mega Evolutions Promos',
  // McDonald's & misc
  'mcd21':     'McDonald\'s Collection 2021',
  'mcd22':     'McDonald\'s Match Battle 2022',
  'm23':       'McDonald\'s Match Battle 2023',
  'm24':       'McDonald\'s Dragon Discovery 2024',
  'm11':       'McDonald\'s Collection 2011',
  'm12':       'McDonald\'s Collection 2012',
  'det1':      'Detective Pikachu',
  'ru1':       'Pokémon Rumble',
  'np':        'Nintendo Promos',
  'bp':        'Best of Game',
  'pcp':       'Poké Card Creator Pack',
  // Play! Pokemon Prize Packs
  'pp1':       'Play! Pokémon Prize Pack Series One',
  'pp2':       'Play! Pokémon Prize Pack Series Two',
  'pp3':       'Play! Pokémon Prize Pack Series Three',
  'pp4':       'Play! Pokémon Prize Pack Series Four',
  'pp5':       'Play! Pokémon Prize Pack Series Five',
  'pp6':       'Play! Pokémon Prize Pack Series Six',
  'pp7':       'Play! Pokémon Prize Pack Series Seven',
  // POP Series
  'pop1':      'POP Series 1',
  'pop2':      'POP Series 2',
  'pop3':      'POP Series 3',
  'pop4':      'POP Series 4',
  'pop5':      'POP Series 5',
  'pop6':      'POP Series 6',
  'pop7':      'POP Series 7',
  'pop8':      'POP Series 8',
  'pop9':      'POP Series 9',
  // Holiday / special
  'hc22':      'Holiday Calendar 2022',
  'hc23':      'Holiday Calendar 2023',
  'hc24':      'Holiday Calendar 2024',
  'hc25':      'Holiday Calendar 2025',
  'tot22':     'Trick or Trade 2022',
  'tot23':     'Trick or Trade 2023',
  'tot24':     'Trick or Trade 2024',
  'fbb':       'My First Battle (Bulbasaur)',
  'fbc':       'My First Battle (Charmander)',
  'fbp':       'My First Battle (Pikachu)',
  'fbs':       'My First Battle (Squirtle)',
  'clb':       'Pokémon TCG Classic (Blastoise)',
  'clc':       'Pokémon TCG Classic (Charizard)',
  'clv':       'Pokémon TCG Classic (Venusaur)',
  'misc':      'Miscellaneous Products',
  'mp':        'Miscellaneous Promos',
  'si1':       'Countdown Calendar',
};

function convertSetIdToPokePulse(tcgdexSetId) {
  if (POKEPULSE_SET_OVERRIDES[tcgdexSetId]) return POKEPULSE_SET_OVERRIDES[tcgdexSetId];
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

// Bulk search: fetch ALL cards for a set in one call (no cardName filter)
async function searchCatalogueBulk(setId, page = 1) {
  const response = await fetch(CATALOGUE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify({
      setId,
      excludeGraded: true,
      limit: 500,
      page
    })
  });
  if (!response.ok) throw new Error(`Catalogue API error: ${response.status}`);
  return response.json();
}

// Bulk-cache all sets using the PokePulse set list directly (no card_index dependency)
async function bulkImportAllSets() {
  console.log('📦 Bulk PokePulse Cache — fetching all sets from PokePulse set list\n');

  const setEntries = Object.entries(POKEPULSE_SETS);
  console.log(`${setEntries.length} PokePulse sets to process\n`);

  let totalApiCalls = 0;
  let totalCached = 0;
  let setsProcessed = 0;
  let setsSkipped = 0;
  let setsFailed = 0;

  for (const [ppSetId, setName] of setEntries) {
    // Check existing cache count
    const existing = await pool.query(
      'SELECT COUNT(*) FROM pokepulse_catalogue WHERE set_id = $1 AND material IS NULL',
      [ppSetId]
    );
    const cachedCount = parseInt(existing.rows[0].count);

    // Skip if already has cached cards (any amount means we've fetched it before)
    if (cachedCount > 0) {
      console.log(`  SKIP ${setName} (${ppSetId}) — ${cachedCount} already cached`);
      setsSkipped++;
      continue;
    }

    // Skip sets marked as unsupported
    const skipCheck = await pool.query(
      "SELECT 1 FROM pokepulse_catalogue WHERE product_id = $1",
      [`SKIP_${ppSetId}`]
    );
    if (skipCheck.rows.length > 0) {
      console.log(`  SKIP ${setName} (${ppSetId}) — marked unsupported`);
      setsSkipped++;
      continue;
    }

    console.log(`  Fetching ${setName} (${ppSetId})...`);

    let page = 1;
    let setCached = 0;
    let hasMore = true;

    while (hasMore) {
      // Safety: stop before hitting daily limit
      if (totalApiCalls >= 900) {
        console.log(`\n⚠️  Stopping — approaching 1000 API calls/day limit (${totalApiCalls} used)`);
        hasMore = false;
        break;
      }

      try {
        const data = await searchCatalogueBulk(ppSetId, page);
        totalApiCalls++;

        const cards = extractCardsArray(data);

        if (!cards || cards.length === 0) {
          if (page === 1) {
            console.log(`    0 results for "${ppSetId}"`);
            setsFailed++;
          }
          break;
        }

        for (const card of cards) {
          const ok = await cacheCard(card, ppSetId);
          if (ok) setCached++;
        }

        const pagination = data.pagination;
        hasMore = pagination?.hasNextPage === true;

        console.log(`    Page ${page}: ${cards.length} cards (total: ${pagination?.totalResults || '?'})`);
        page++;

        if (hasMore) await delay(1000);
      } catch (err) {
        if (err.message.includes('429')) {
          console.log(`    Rate limited. Waiting 60s...`);
          await delay(60000);
        } else {
          console.log(`    ERROR: ${err.message}`);
          setsFailed++;
          break;
        }
      }
    }

    if (totalApiCalls >= 900) break;

    console.log(`    Cached ${setCached} products\n`);
    totalCached += setCached;
    setsProcessed++;

    await delay(2000);
  }

  console.log(`\n════════════════════════════════════`);
  console.log(`Bulk import complete:`);
  console.log(`  Sets processed: ${setsProcessed}`);
  console.log(`  Sets skipped (already cached): ${setsSkipped}`);
  console.log(`  Sets with 0 results: ${setsFailed}`);
  console.log(`  API calls used: ${totalApiCalls}`);
  console.log(`  Products cached: ${totalCached}`);
}

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

// Discover set IDs by sampling every 10th page of the PokePulse catalogue (~31 calls)
async function discoverSets() {
  console.log('🔍 Discovering PokePulse set IDs (sampling every 10th page)...\n');
  const allSets = new Map();
  const pageSize = 1000;
  let totalPages = 1;

  // First call to get total pages
  const firstRes = await fetch(CATALOGUE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ page: 1, page_size: pageSize }),
  });
  if (!firstRes.ok) throw new Error(`API error: ${firstRes.status}`);
  const firstData = await firstRes.json();

  if (firstData.pagination) {
    totalPages = firstData.pagination.total_pages || Math.ceil((firstData.pagination.total || 0) / pageSize);
    console.log(`   ${firstData.pagination.total || '?'} total cards, ${totalPages} pages — sampling ~${Math.ceil(totalPages / 10)} pages\n`);
  }

  // Process first page
  for (const c of extractCardsArray(firstData)) {
    const sid = c.set_id || 'unknown';
    if (!allSets.has(sid)) allSets.set(sid, { name: c.set_name || '', count: 0 });
    allSets.get(sid).count++;
  }

  // Sample every 10th page
  for (let page = 10; page <= totalPages; page += 10) {
    try {
      const res = await fetch(CATALOGUE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body: JSON.stringify({ page, page_size: pageSize }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();

      for (const c of extractCardsArray(data)) {
        const sid = c.set_id || 'unknown';
        if (!allSets.has(sid)) allSets.set(sid, { name: c.set_name || '', count: 0 });
        allSets.get(sid).count++;
      }

      process.stdout.write(`   Page ${page}/${totalPages} — ${allSets.size} sets found so far\r`);
      await delay(500);
    } catch (err) {
      console.error(`\n   ❌ Page ${page} error: ${err.message}`);
      if (err.message.includes('429')) {
        console.log('   Waiting 60s for rate limit...');
        await delay(60000);
        page -= 10; // retry
      }
    }
  }

  console.log(`\n\n   ✅ Found ${allSets.size} sets:\n`);
  const sorted = [...allSets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [id, info] of sorted) {
    console.log(`   ${id.padEnd(20)} ${info.name.padEnd(35)} (${info.count} sampled)`);
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
       ci.pokepulse_set_id as pp_set_id,
       ci.set_name,
       ci.card_count as index_cards,
       COALESCE(pp.cached, 0) as cached_cards
     FROM (
       SELECT set_id, pokepulse_set_id, set_name, COUNT(DISTINCT name) as card_count
       FROM card_index
       GROUP BY set_id, pokepulse_set_id, set_name
     ) ci
     LEFT JOIN (
       SELECT set_id, COUNT(*) FILTER (WHERE material IS NULL) as cached
       FROM pokepulse_catalogue
       GROUP BY set_id
     ) pp ON pp.set_id = ci.pokepulse_set_id
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
    `SELECT ci.set_id, ci.pokepulse_set_id, ci.set_name, ci.card_count as index_cards,
       COALESCE(pp.cached, 0) as cached_cards,
       CASE
         WHEN ci.set_id LIKE 'sv%' THEN 1
         WHEN ci.set_id LIKE 'swsh%' THEN 2
         WHEN ci.set_id LIKE 'sm%' THEN 3
         WHEN ci.set_id LIKE 'xy%' THEN 4
         ELSE 5
       END as era_priority
     FROM (
       SELECT set_id, pokepulse_set_id, set_name, COUNT(DISTINCT name) as card_count
       FROM card_index
       WHERE pokepulse_set_id IS NOT NULL
       GROUP BY set_id, pokepulse_set_id, set_name
     ) ci
     LEFT JOIN (
       SELECT set_id, COUNT(*) FILTER (WHERE material IS NULL) as cached
       FROM pokepulse_catalogue
       GROUP BY set_id
     ) pp ON pp.set_id = ci.pokepulse_set_id
     WHERE COALESCE(pp.cached, 0) < ci.card_count * 0.8
       AND NOT EXISTS (
         SELECT 1 FROM pokepulse_catalogue sk
         WHERE sk.set_id = ci.pokepulse_set_id AND sk.product_id LIKE 'SKIP_%'
       )
     ORDER BY era_priority ASC, COALESCE(pp.cached, 0) ASC, ci.card_count DESC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

// Import one set using bulk fetch (1-2 API calls instead of one per card name)
async function importSet(tcgdexSetId, ppSetIdOverride) {
  let ppSetId = ppSetIdOverride;
  if (!ppSetId) {
    const ppRow = await pool.query('SELECT pokepulse_set_id FROM card_index WHERE set_id = $1 AND pokepulse_set_id IS NOT NULL LIMIT 1', [tcgdexSetId]);
    ppSetId = ppRow.rows[0]?.pokepulse_set_id || convertSetIdToPokePulse(tcgdexSetId);
  }

  const setNameResult = await pool.query('SELECT set_name FROM card_index WHERE set_id = $1 LIMIT 1', [tcgdexSetId]);
  const setName = setNameResult.rows[0]?.set_name || tcgdexSetId;

  const cachedCount = await pool.query(
    'SELECT COUNT(*) FROM pokepulse_catalogue WHERE set_id = $1 AND material IS NULL', [ppSetId]
  );
  const already = parseInt(cachedCount.rows[0].count);

  console.log(`\n📦 ${setName} (${tcgdexSetId} → ${ppSetId})`);
  console.log(`   ${already} already cached\n`);

  let cached = 0;
  let apiCalls = 0;
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    try {
      const data = await searchCatalogueBulk(ppSetId, page);
      apiCalls++;

      const cards = extractCardsArray(data);
      if (!cards || cards.length === 0) {
        if (page === 1) {
          console.log(`   ⚠️  0 results — "${ppSetId}" may not exist in PokePulse`);
        }
        break;
      }

      for (const card of cards) {
        const ok = await cacheCard(card, ppSetId);
        if (ok) cached++;
      }

      const pagination = data.pagination;
      hasMore = pagination?.hasNextPage === true;
      console.log(`   Page ${page}: ${cards.length} cards (total: ${pagination?.totalResults || '?'})`);
      page++;

      if (hasMore) await delay(1000);
    } catch (err) {
      if (err.message.includes('429')) {
        console.log(`   ⚠️  Rate limited, waiting 60s...`);
        await delay(60000);
      } else {
        console.log(`   ❌ ${err.message}`);
        break;
      }
    }
  }

  console.log(`\n   ✅ Done — ${cached} products cached, ${apiCalls} API calls`);

  // Mark as unsupported if nothing found
  if (cached === 0 && apiCalls >= 1) {
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

  return { cached, apiCalls, errors: 0 };
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

  // Bulk mode — fetch all vending sets in minimal API calls
  if (args.includes('--bulk')) {
    await bulkImportAllSets();
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

  await importSet(targetSet.set_id, targetSet.pokepulse_set_id);

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
