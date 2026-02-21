// Quick test to discover PokePulse sealed product API endpoints
// Run: node src/test-sealed-api.js
require('dotenv').config();

const CATALOGUE_KEY = process.env.POKEPULSE_CATALOGUE_KEY;
const MARKET_KEY = process.env.POKEPULSE_MARKET_KEY;
const BASE_URL = 'https://catalogueservicev2-production.up.railway.app/api';
const MARKET_URL = 'https://marketdataapi-production.up.railway.app/api';

const headers = { 'Content-Type': 'application/json', 'X-API-Key': CATALOGUE_KEY };

async function tryEndpoint(label, url, options = {}) {
  try {
    const res = await fetch(url, { headers, ...options });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    console.log(`\n${res.ok ? '✅' : '❌'} ${label} [${res.status}]`);
    console.log(`   URL: ${url}`);
    if (typeof data === 'object') {
      console.log(`   Response:`, JSON.stringify(data, null, 2).slice(0, 500));
    } else {
      console.log(`   Response: ${text.slice(0, 200)}`);
    }
    return { ok: res.ok, data };
  } catch (err) {
    console.log(`\n❌ ${label} — ${err.message}`);
    return { ok: false };
  }
}

async function main() {
  console.log('🔍 Probing PokePulse for sealed product API endpoints...\n');

  // Test 1: Try the cards/search endpoint with a sealed product name
  await tryEndpoint(
    'Cards search with sealed name',
    `${BASE_URL}/cards/search`,
    { method: 'POST', body: JSON.stringify({ cardName: 'Ascended Heroes Elite Trainer Box', limit: 5 }) }
  );

  // Test 2: Try /api/sealed/search
  await tryEndpoint(
    'Sealed search endpoint',
    `${BASE_URL}/sealed/search`,
    { method: 'POST', body: JSON.stringify({ name: 'Ascended Heroes Elite Trainer Box', limit: 5 }) }
  );

  // Test 3: Try /api/products/search
  await tryEndpoint(
    'Products search endpoint',
    `${BASE_URL}/products/search`,
    { method: 'POST', body: JSON.stringify({ name: 'Ascended Heroes Elite Trainer Box', limit: 5 }) }
  );

  // Test 4: Try /api/sealed (GET)
  await tryEndpoint('Sealed base endpoint (GET)', `${BASE_URL}/sealed`);

  // Test 5: Try /api/search (unified)
  await tryEndpoint(
    'Unified search endpoint',
    `${BASE_URL}/search`,
    { method: 'POST', body: JSON.stringify({ query: 'Ascended Heroes Elite Trainer Box', limit: 5 }) }
  );

  // Test 6: Try guessing the product_id format and querying market data
  const sealedGuesses = [
    'sealed:ascended-heroes-pokemon-center-elite-trainer-box-exclusive',
    'sealed:ascended-heroes-pokemon-center-elite-trainer-box-exclusive|null|null',
    'ascended-heroes-pokemon-center-elite-trainer-box-exclusive',
  ];

  for (const guess of sealedGuesses) {
    await tryEndpoint(
      `Market data with product_id: ${guess}`,
      `${MARKET_URL}/market-data/batch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': MARKET_KEY },
        body: JSON.stringify({ productIds: [guess] })
      }
    );
  }

  // Test 7: Try catalogue with category filter
  await tryEndpoint(
    'Cards search with category=sealed',
    `${BASE_URL}/cards/search`,
    { method: 'POST', body: JSON.stringify({ cardName: 'Elite Trainer Box', category: 'sealed', limit: 5 }) }
  );

  // Test 8: Try catalogue with type filter
  await tryEndpoint(
    'Cards search with type=sealed',
    `${BASE_URL}/cards/search`,
    { method: 'POST', body: JSON.stringify({ cardName: 'Elite Trainer Box', type: 'sealed', limit: 5 }) }
  );

  console.log('\n\n🏁 Done. Check which endpoints returned data above.');
}

main().catch(console.error);
