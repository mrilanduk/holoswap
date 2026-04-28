require('dotenv').config();

(async () => {
  const productIds = [
    'card:mep|MEP031|Holo|null|null|null',
    'card:mep|MEP031|null|Pokémon Center|null|null'
  ];
  const url = 'https://marketdataapi-production.up.railway.app/api/market-data/batch';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.POKEPULSE_MARKET_KEY
      },
      body: JSON.stringify({ productIds })
    });
    console.log('Status:', response.status);
    const body = await response.text();
    console.log('Body:', body);
  } catch (e) {
    console.error('ERROR:', e.message);
  }
})();
