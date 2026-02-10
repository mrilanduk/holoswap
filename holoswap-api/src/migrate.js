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
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- Index for fast email lookups
    CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

  `);

  console.log('✅ Tables created:');
  console.log('   - waitlist');
  console.log('   - users');

  // Show current counts
  const waitlistCount = await pool.query('SELECT COUNT(*) FROM waitlist');
  const usersCount = await pool.query('SELECT COUNT(*) FROM users');
  console.log(`\n📊 Current data:`);
  console.log(`   - waitlist: ${waitlistCount.rows[0].count} entries`);
  console.log(`   - users: ${usersCount.rows[0].count} accounts`);

  await pool.end();
  console.log('\n✅ Migration complete');
};

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
