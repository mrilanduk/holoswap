// Run this script on your server to download all Pokemon TCG cards from TCGdex
// and store them in your local database for instant search.
//
// Usage: node import-cards.js
//
// This will:
// 1. Create the card_index table if it doesn't exist
// 2. Fetch all sets from TCGdex
// 3. For each set, fetch all cards with full details
// 4. Insert everything into PostgreSQL
//
// Run time: ~5-10 minutes (17,000+ cards)
// Re-run safe: it clears and rebuilds the table each time

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const TCGDEX_BASE = 'https://api.tcgdex.net/v2/en';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

async function run() {
  console.log('🔄 Creating card_index table...\n');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS card_index (
      id            VARCHAR(50) PRIMARY KEY,
      name          VARCHAR(255) NOT NULL,
      local_id      VARCHAR(50),
      category      VARCHAR(50),
      rarity        VARCHAR(100),
      hp            INTEGER,
      card_type     VARCHAR(100),
      stage         VARCHAR(50),
      evolve_from   VARCHAR(255),
      description   TEXT,
      illustrator   VARCHAR(255),
      image_url     TEXT,
      set_id        VARCHAR(50),
      set_name      VARCHAR(255),
      set_logo      TEXT,
      set_symbol    TEXT,
      set_total     INTEGER,
      variants_normal    BOOLEAN DEFAULT FALSE,
      variants_reverse   BOOLEAN DEFAULT FALSE,
      variants_holo      BOOLEAN DEFAULT FALSE,
      variants_first_ed  BOOLEAN DEFAULT FALSE,
      attacks       JSONB,
      weaknesses    JSONB,
      resistances   JSONB,
      retreat_cost  INTEGER,
      legal_standard BOOLEAN DEFAULT FALSE,
      legal_expanded BOOLEAN DEFAULT FALSE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_card_index_name ON card_index(name);
    CREATE INDEX IF NOT EXISTS idx_card_index_name_lower ON card_index(LOWER(name));
    CREATE INDEX IF NOT EXISTS idx_card_index_local_id ON card_index(local_id);
    CREATE INDEX IF NOT EXISTS idx_card_index_set_id ON card_index(set_id);
    CREATE INDEX IF NOT EXISTS idx_card_index_set_name ON card_index(set_name);
    CREATE INDEX IF NOT EXISTS idx_card_index_rarity ON card_index(rarity);
    CREATE INDEX IF NOT EXISTS idx_card_index_card_type ON card_index(card_type);
    CREATE INDEX IF NOT EXISTS idx_card_index_category ON card_index(category);
  `);

  // Clear existing data for fresh import
  await pool.query('TRUNCATE card_index');

  console.log('📥 Fetching sets from TCGdex...');
  const sets = await fetchJSON(`${TCGDEX_BASE}/sets`);
  console.log(`   Found ${sets.length} sets\n`);

  let totalCards = 0;
  let errors = 0;

  for (let i = 0; i < sets.length; i++) {
    const set = sets[i];
    const setId = set.id;

    try {
      // Fetch full set with all cards
      const setData = await fetchJSON(`${TCGDEX_BASE}/sets/${setId}`);
      const cards = setData.cards || [];

      if (cards.length === 0) continue;

      // Batch fetch card details - fetch each card individually for full data
      const values = [];
      const placeholders = [];
      let paramIdx = 1;

      for (const cardBrief of cards) {
        try {
          const card = await fetchJSON(`${TCGDEX_BASE}/cards/${cardBrief.id}`);

          const types = Array.isArray(card.types) ? card.types.join(', ') : null;
          const retreatCost = Array.isArray(card.retreat) ? card.retreat.length : null;

          values.push(
            card.id,
            card.name,
            card.localId || null,
            card.category || null,
            card.rarity || null,
            card.hp ? parseInt(card.hp) : null,
            types,
            card.stage || null,
            card.evolveFrom || null,
            card.description || null,
            card.illustrator || null,
            card.image ? card.image + '/low.webp' : null,
            setData.id,
            setData.name,
            setData.logo ? setData.logo + '.webp' : null,
            setData.symbol ? setData.symbol + '.webp' : null,
            setData.cardCount?.total || null,
            card.variants?.normal || false,
            card.variants?.reverse || false,
            card.variants?.holo || false,
            card.variants?.firstEdition || false,
            card.attacks ? JSON.stringify(card.attacks) : null,
            card.weaknesses ? JSON.stringify(card.weaknesses) : null,
            card.resistances ? JSON.stringify(card.resistances) : null,
            retreatCost,
            card.legal?.standard || false,
            card.legal?.expanded || false
          );

          const nums = [];
          for (let n = 0; n < 27; n++) {
            nums.push(`$${paramIdx++}`);
          }
          placeholders.push(`(${nums.join(',')})`);

          totalCards++;
        } catch (cardErr) {
          errors++;
        }

        // Small delay to be nice to the API
        if (totalCards % 10 === 0) {
          await new Promise(r => setTimeout(r, 50));
        }
      }

      // Bulk insert this set's cards
      if (placeholders.length > 0) {
        await pool.query(`
          INSERT INTO card_index (
            id, name, local_id, category, rarity, hp, card_type, stage, evolve_from,
            description, illustrator, image_url, set_id, set_name, set_logo, set_symbol,
            set_total, variants_normal, variants_reverse, variants_holo, variants_first_ed,
            attacks, weaknesses, resistances, retreat_cost, legal_standard, legal_expanded
          ) VALUES ${placeholders.join(',')}
          ON CONFLICT (id) DO NOTHING
        `, values);
      }

      console.log(`   ✅ ${setData.name} — ${cards.length} cards (${i + 1}/${sets.length})`);

    } catch (setErr) {
      console.log(`   ❌ Failed to fetch set ${setId}: ${setErr.message}`);
      errors++;
    }
  }

  // Final count
  const result = await pool.query('SELECT COUNT(*) FROM card_index');

  console.log(`\n✅ Import complete!`);
  console.log(`   Total cards indexed: ${result.rows[0].count}`);
  console.log(`   Errors: ${errors}`);

  await pool.end();
}

run().catch(err => {
  console.error('❌ Import failed:', err);
  process.exit(1);
});
