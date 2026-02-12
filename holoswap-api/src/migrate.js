require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const migrate = async () => {
  console.log('🔄 Running migrations...\n');

  await pool.query(`

    -- Waitlist signups from landing page
    CREATE TABLE IF NOT EXISTS waitlist (
      id            SERIAL PRIMARY KEY,
      email         VARCHAR(255) UNIQUE NOT NULL,
      source        VARCHAR(50) DEFAULT 'landing_page',
      ip_address    VARCHAR(45),
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- User accounts
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name  VARCHAR(100),
      avatar_url    TEXT,
      city          VARCHAR(100),
      postcode      VARCHAR(20),
      bio           TEXT,
      is_pro        BOOLEAN DEFAULT FALSE,
      is_admin      BOOLEAN DEFAULT FALSE,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- Cards submitted by users (physical cards sent to HoloSwap)
    CREATE TABLE IF NOT EXISTS cards (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
      card_name     VARCHAR(255) NOT NULL,
      card_set      VARCHAR(255),
      card_number   VARCHAR(50),
      rarity        VARCHAR(50),
      condition     VARCHAR(50) DEFAULT 'unknown',
      status        VARCHAR(50) DEFAULT 'pending',
      notes         TEXT,
      image_url     TEXT,
      scan_front    TEXT,
      scan_back     TEXT,
      estimated_value DECIMAL(10,2),
      verified_at   TIMESTAMPTZ,
      verified_by   INTEGER REFERENCES users(id),
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- Want list (cards users are looking for)
    CREATE TABLE IF NOT EXISTS want_list (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
      card_name     VARCHAR(255) NOT NULL,
      card_set      VARCHAR(255),
      card_number   VARCHAR(50),
      rarity        VARCHAR(50),
      min_condition VARCHAR(50) DEFAULT 'played',
      notes         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- Shipping labels / submissions
    CREATE TABLE IF NOT EXISTS submissions (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
      tracking_number VARCHAR(100),
      status        VARCHAR(50) DEFAULT 'label_created',
      card_count    INTEGER DEFAULT 0,
      notes         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(user_id);
    CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
    CREATE INDEX IF NOT EXISTS idx_want_list_user ON want_list(user_id);
    CREATE INDEX IF NOT EXISTS idx_want_list_card ON want_list(card_name);
    CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id);

    -- Address fields for delivery
    ALTER TABLE users ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS address_line2 VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS county VARCHAR(100);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS country VARCHAR(100) DEFAULT 'United Kingdom';

  `);

  console.log('✅ Tables created:');
  console.log('   - waitlist');
  console.log('   - users');
  console.log('   - cards');
  console.log('   - want_list');
  console.log('   - submissions');

  const tables = ['waitlist', 'users', 'cards', 'want_list', 'submissions'];
  console.log('\n📊 Current data:');
  for (const t of tables) {
    const r = await pool.query(`SELECT COUNT(*) FROM ${t}`);
    console.log(`   - ${t}: ${r.rows[0].count} entries`);
  }

  await pool.end();
  console.log('\n✅ Migration complete');
};

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
