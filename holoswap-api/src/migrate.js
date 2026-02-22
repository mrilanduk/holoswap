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

    -- Customer info on baskets
    ALTER TABLE vending_lookups ADD COLUMN IF NOT EXISTS customer_name VARCHAR(100);
    ALTER TABLE vending_lookups ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255);
    ALTER TABLE vending_lookups ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50);

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

    -- PokePulse set ID stored directly on card_index (no more runtime conversion)
    ALTER TABLE card_index ADD COLUMN IF NOT EXISTS pokepulse_set_id VARCHAR(50);
    CREATE INDEX IF NOT EXISTS idx_card_index_pp_set_id ON card_index(pokepulse_set_id);

    -- Prize wheel config (vendor's wheel segments)
    CREATE TABLE IF NOT EXISTS prize_wheel_config (
      id         SERIAL PRIMARY KEY,
      vendor_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
      label      VARCHAR(100) NOT NULL,
      prize_type VARCHAR(20) NOT NULL DEFAULT 'none',
      prize_value VARCHAR(100),
      weight     INTEGER NOT NULL DEFAULT 1,
      color      VARCHAR(7) DEFAULT '#3b82f6',
      position   INTEGER NOT NULL DEFAULT 0,
      is_active  BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_prize_wheel_config_vendor ON prize_wheel_config(vendor_id);

    -- Prize wheel spin results (one spin per basket)
    CREATE TABLE IF NOT EXISTS prize_wheel_spins (
      id            SERIAL PRIMARY KEY,
      basket_id     VARCHAR(50) NOT NULL UNIQUE,
      vendor_id     INTEGER REFERENCES users(id),
      config_id     INTEGER REFERENCES prize_wheel_config(id),
      prize_label   VARCHAR(100) NOT NULL,
      prize_type    VARCHAR(20) NOT NULL,
      prize_value   VARCHAR(100),
      customer_name VARCHAR(100),
      redeemed      BOOLEAN DEFAULT FALSE,
      redeemed_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_prize_wheel_spins_vendor ON prize_wheel_spins(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_prize_wheel_spins_basket ON prize_wheel_spins(basket_id);

    -- Vendor prize wheel toggle
    ALTER TABLE users ADD COLUMN IF NOT EXISTS prize_wheel_enabled BOOLEAN DEFAULT FALSE;

    -- Price watchlist (cards users are tracking)
    CREATE TABLE IF NOT EXISTS price_watchlist (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      set_id        VARCHAR(50) NOT NULL,
      card_number   VARCHAR(50) NOT NULL,
      card_name     VARCHAR(255),
      set_name      VARCHAR(255),
      image_url     TEXT,
      product_id    VARCHAR(100),
      last_price    DECIMAL(10,2),
      last_checked  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, set_id, card_number)
    );
    CREATE INDEX IF NOT EXISTS idx_price_watchlist_user ON price_watchlist(user_id);
    CREATE INDEX IF NOT EXISTS idx_price_watchlist_product ON price_watchlist(product_id);

    -- Sealed product support: add product_type, make card_number nullable
    ALTER TABLE price_watchlist ADD COLUMN IF NOT EXISTS product_type VARCHAR(20) DEFAULT 'card';
    ALTER TABLE price_watchlist ALTER COLUMN card_number DROP NOT NULL;
    ALTER TABLE price_watchlist ALTER COLUMN set_id DROP NOT NULL;

    -- Partial unique indexes for cards vs sealed products
    -- (the original UNIQUE constraint still covers cards; this adds sealed)
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pw_sealed_unique
      ON price_watchlist(user_id, card_name) WHERE product_type = 'sealed';

    -- Price alerts (threshold / percentage triggers)
    CREATE TABLE IF NOT EXISTS price_alerts (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      watchlist_id    INTEGER NOT NULL REFERENCES price_watchlist(id) ON DELETE CASCADE,
      alert_type      VARCHAR(20) NOT NULL,
      threshold       DECIMAL(10,2) NOT NULL,
      is_active       BOOLEAN DEFAULT TRUE,
      last_triggered  TIMESTAMPTZ,
      cooldown_hours  INTEGER DEFAULT 24,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_price_alerts_watchlist ON price_alerts(watchlist_id);
    CREATE INDEX IF NOT EXISTS idx_price_alerts_user ON price_alerts(user_id);
    CREATE INDEX IF NOT EXISTS idx_price_alerts_active ON price_alerts(is_active) WHERE is_active = TRUE;

    -- Notification settings (per user, one row each)
    CREATE TABLE IF NOT EXISTS notification_settings (
      id                SERIAL PRIMARY KEY,
      user_id           INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      web_push_sub      JSONB,
      telegram_chat_id  VARCHAR(100),
      pushover_user_key VARCHAR(100),
      ntfy_topic        VARCHAR(100),
      channels_enabled  JSONB DEFAULT '[]'::jsonb,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );

    -- Notification log (delivery audit trail)
    CREATE TABLE IF NOT EXISTS notification_log (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      alert_id        INTEGER REFERENCES price_alerts(id) ON DELETE SET NULL,
      channel         VARCHAR(20) NOT NULL,
      title           VARCHAR(255),
      body            TEXT,
      status          VARCHAR(20) DEFAULT 'pending',
      error_message   TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notification_log_user ON notification_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_notification_log_created ON notification_log(created_at DESC);

    -- Seller submissions (TrainerMart Trade — cards offered for sale by public)
    CREATE TABLE IF NOT EXISTS seller_submissions (
      id              SERIAL PRIMARY KEY,
      submission_id   VARCHAR(50) UNIQUE NOT NULL,
      seller_name     VARCHAR(255) NOT NULL,
      seller_email    VARCHAR(255),
      seller_phone    VARCHAR(50),
      status          VARCHAR(20) DEFAULT 'pending',
      admin_notes     TEXT,
      total_items     INTEGER DEFAULT 0,
      total_asking    NUMERIC(10,2),
      total_offered   NUMERIC(10,2),
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_seller_submissions_status ON seller_submissions(status);
    CREATE INDEX IF NOT EXISTS idx_seller_submissions_created ON seller_submissions(created_at DESC);

    -- Seller submissions: vendor support
    ALTER TABLE seller_submissions ADD COLUMN IF NOT EXISTS vendor_id INTEGER REFERENCES users(id);
    CREATE INDEX IF NOT EXISTS idx_seller_submissions_vendor ON seller_submissions(vendor_id);

    CREATE TABLE IF NOT EXISTS seller_submission_items (
      id              SERIAL PRIMARY KEY,
      submission_id   VARCHAR(50) REFERENCES seller_submissions(submission_id) ON DELETE CASCADE,
      card_name       VARCHAR(255),
      set_name        VARCHAR(255),
      set_id          VARCHAR(100),
      card_number     VARCHAR(50),
      image_url       TEXT,
      market_price    NUMERIC(10,2),
      asking_price    NUMERIC(10,2),
      offer_price     NUMERIC(10,2),
      condition       VARCHAR(10) DEFAULT 'NM',
      status          VARCHAR(20) DEFAULT 'pending',
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_seller_items_submission ON seller_submission_items(submission_id);

    -- Vendor personalisation settings
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_accent_color VARCHAR(20);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_logo_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_title VARCHAR(100);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_buy_nm NUMERIC(4,2);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_buy_lp NUMERIC(4,2);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_buy_mp NUMERIC(4,2);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_buy_hp NUMERIC(4,2);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_trade_nm NUMERIC(4,2);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_trade_lp NUMERIC(4,2);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_trade_mp NUMERIC(4,2);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_trade_hp NUMERIC(4,2);

  `);

  // Backfill pokepulse_set_id from existing set_id (pure SQL, no API calls)
  const backfill = await pool.query(`
    UPDATE card_index
    SET pokepulse_set_id = CASE
      WHEN set_id LIKE '%.%' THEN
        regexp_replace(split_part(set_id, '.', 1), '(\\D+)0*(\\d+)', '\\1\\2') || 'pt' || split_part(set_id, '.', 2)
      ELSE
        regexp_replace(set_id, '(\\D+)0*(\\d+)', '\\1\\2')
    END
    WHERE pokepulse_set_id IS NULL
  `);
  if (backfill.rowCount > 0) {
    console.log(`\n🔄 Backfilled pokepulse_set_id on ${backfill.rowCount} card_index rows`);
  }

  // Fix set IDs that don't follow standard conversion (matches POKEPULSE_SET_OVERRIDES in pricing.js)
  const overrideFix = await pool.query(`
    UPDATE card_index SET pokepulse_set_id = 'm1' WHERE set_id = 'me01' AND pokepulse_set_id != 'm1';
    UPDATE card_index SET pokepulse_set_id = 'me02' WHERE set_id = 'me02' AND pokepulse_set_id != 'me02';
    UPDATE card_index SET pokepulse_set_id = 'mep' WHERE set_id = 'MEP' AND pokepulse_set_id != 'mep';
    UPDATE card_index SET pokepulse_set_id = 'rsv10pt5' WHERE set_id = 'sv10.5w' AND pokepulse_set_id != 'rsv10pt5';
    UPDATE card_index SET pokepulse_set_id = 'zsv10pt5' WHERE set_id = 'sv10.5b' AND pokepulse_set_id != 'zsv10pt5';
    UPDATE card_index SET pokepulse_set_id = 'cel25' WHERE set_id = 'swsh7.5' AND pokepulse_set_id != 'cel25';
    UPDATE card_index SET pokepulse_set_id = 'pgo' WHERE set_id = 'swsh10.5' AND pokepulse_set_id != 'pgo';
    UPDATE card_index SET pokepulse_set_id = 'sm3pt5' WHERE set_id = 'sm35' AND pokepulse_set_id != 'sm3pt5';
    UPDATE card_index SET pokepulse_set_id = 'bsu' WHERE set_id = 'base1' AND pokepulse_set_id != 'bsu';
    UPDATE card_index SET pokepulse_set_id = 'tr' WHERE set_id = 'base5' AND pokepulse_set_id != 'tr';
  `);
  if (overrideFix.rowCount > 0) {
    console.log(`\n🔄 Fixed pokepulse_set_id overrides for ${overrideFix.rowCount} rows`);
  }

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
  console.log('   - prize_wheel_config');
  console.log('   - prize_wheel_spins');
  console.log('   - price_watchlist');
  console.log('   - price_alerts');
  console.log('   - notification_settings');
  console.log('   - notification_log');
  console.log('   - seller_submissions');
  console.log('   - seller_submission_items');

  const tables = ['waitlist', 'users', 'cards', 'want_list', 'submissions', 'binders', 'binder_cards', 'vending_lookups', 'vending_daily_summaries', 'prize_wheel_config', 'prize_wheel_spins', 'price_watchlist', 'price_alerts', 'notification_settings', 'notification_log', 'seller_submissions', 'seller_submission_items'];
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
