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

    -- Binders (collections for organizing cards)
    CREATE TABLE IF NOT EXISTS binders (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          VARCHAR(255) NOT NULL,
      description   TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- Binder cards join table (many-to-many)
    CREATE TABLE IF NOT EXISTS binder_cards (
      id            SERIAL PRIMARY KEY,
      binder_id     INTEGER NOT NULL REFERENCES binders(id) ON DELETE CASCADE,
      card_id       INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      position      INTEGER DEFAULT 0,
      added_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(binder_id, card_id)
    );

    -- Vending show price lookups & sales
    CREATE TABLE IF NOT EXISTS vending_lookups (
      id            SERIAL PRIMARY KEY,
      raw_input     VARCHAR(255) NOT NULL,
      set_code      VARCHAR(50),
      card_number   VARCHAR(50),
      card_name     VARCHAR(255),
      set_name      VARCHAR(255),
      set_id        VARCHAR(50),
      image_url     TEXT,
      market_price  DECIMAL(10,2),
      currency      VARCHAR(10) DEFAULT 'GBP',
      status        VARCHAR(50) DEFAULT 'pending',
      sale_price    DECIMAL(10,2),
      sale_notes    TEXT,
      completed_by  INTEGER REFERENCES users(id),
      completed_at  TIMESTAMPTZ,
      ip_address    VARCHAR(45),
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(user_id);
    CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
    CREATE INDEX IF NOT EXISTS idx_want_list_user ON want_list(user_id);
    CREATE INDEX IF NOT EXISTS idx_want_list_card ON want_list(card_name);
    CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id);
    CREATE INDEX IF NOT EXISTS idx_binders_user ON binders(user_id);
    CREATE INDEX IF NOT EXISTS idx_binder_cards_binder ON binder_cards(binder_id);
    CREATE INDEX IF NOT EXISTS idx_binder_cards_card ON binder_cards(card_id);
    CREATE INDEX IF NOT EXISTS idx_vending_lookups_status ON vending_lookups(status);
    CREATE INDEX IF NOT EXISTS idx_vending_lookups_created ON vending_lookups(created_at DESC);

    -- Address fields for delivery
    ALTER TABLE users ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS address_line2 VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS county VARCHAR(100);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS country VARCHAR(100) DEFAULT 'United Kingdom';

    -- Vending: buy/sell type
    ALTER TABLE vending_lookups ADD COLUMN IF NOT EXISTS type VARCHAR(10) DEFAULT 'sell';

    -- Vending: basket grouping
    ALTER TABLE vending_lookups ADD COLUMN IF NOT EXISTS basket_id VARCHAR(50);

    -- Vending: payment method (card/cash)
    ALTER TABLE vending_lookups ADD COLUMN IF NOT EXISTS payment_method VARCHAR(10);

    -- Multi-vendor support
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_vendor BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_code VARCHAR(50) UNIQUE;
    ALTER TABLE vending_lookups ADD COLUMN IF NOT EXISTS vendor_id INTEGER REFERENCES users(id);
    CREATE INDEX IF NOT EXISTS idx_vending_lookups_vendor ON vending_lookups(vendor_id);

    -- Vendor support on daily summaries
    ALTER TABLE vending_daily_summaries ADD COLUMN IF NOT EXISTS vendor_id INTEGER REFERENCES users(id);
    CREATE INDEX IF NOT EXISTS idx_vending_daily_summaries_vendor ON vending_daily_summaries(vendor_id);

    -- Daily vending summaries (committed end-of-day snapshots)
    CREATE TABLE IF NOT EXISTS vending_daily_summaries (
      id            SERIAL PRIMARY KEY,
      summary_date  DATE UNIQUE NOT NULL,
      total_sold    DECIMAL(10,2) NOT NULL DEFAULT 0,
      cards_sold    INTEGER NOT NULL DEFAULT 0,
      total_bought  DECIMAL(10,2) NOT NULL DEFAULT 0,
      cards_bought  INTEGER NOT NULL DEFAULT 0,
      net_profit    DECIMAL(10,2) NOT NULL DEFAULT 0,
      notes         TEXT,
      committed_by  INTEGER REFERENCES users(id),
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_vending_daily_summaries_date ON vending_daily_summaries(summary_date DESC);

    -- Market price history for tracking trends
    CREATE TABLE IF NOT EXISTS market_price_history (
      id              SERIAL PRIMARY KEY,
      set_id          VARCHAR(50) NOT NULL,
      card_number     VARCHAR(50) NOT NULL,
      card_name       VARCHAR(255),
      market_price    DECIMAL(10,2),
      last_sold_price DECIMAL(10,2),
      last_sold_date  TIMESTAMPTZ,
      trend_7d_pct    DECIMAL(10,2),
      trend_30d_pct   DECIMAL(10,2),
      snapshot_date   DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(set_id, card_number, snapshot_date)
    );

    CREATE INDEX IF NOT EXISTS idx_market_history_card ON market_price_history(set_id, card_number);
    CREATE INDEX IF NOT EXISTS idx_market_history_date ON market_price_history(snapshot_date DESC);
    CREATE INDEX IF NOT EXISTS idx_market_history_price ON market_price_history(market_price DESC);

    -- PokePulse catalogue cache (builds up over time from lookups)
    CREATE TABLE IF NOT EXISTS pokepulse_catalogue (
      id              SERIAL PRIMARY KEY,
      product_id      VARCHAR(100) UNIQUE NOT NULL,
      set_id          VARCHAR(50),
      card_number     VARCHAR(50),
      card_name       VARCHAR(255),
      material        VARCHAR(50),
      rarity          VARCHAR(100),
      image_url       TEXT,
      last_fetched    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_pp_catalogue_set_card ON pokepulse_catalogue(set_id, card_number);
    CREATE INDEX IF NOT EXISTS idx_pp_catalogue_name ON pokepulse_catalogue(card_name);
    CREATE INDEX IF NOT EXISTS idx_pp_catalogue_product ON pokepulse_catalogue(product_id);

  `);

  console.log('✅ Tables created:');
  console.log('   - waitlist');
  console.log('   - users');
  console.log('   - cards');
  console.log('   - want_list');
  console.log('   - market_price_history');
  console.log('   - submissions');
  console.log('   - binders');
  console.log('   - binder_cards');
  console.log('   - vending_lookups');
  console.log('   - vending_daily_summaries');

  const tables = ['waitlist', 'users', 'cards', 'want_list', 'submissions', 'binders', 'binder_cards', 'vending_lookups', 'vending_daily_summaries'];
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
