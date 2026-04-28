require('dotenv').config();

(async () => {
  try {
    const productId = 'card:gen|RC28/RC32|Holo|null|null|null';
    const url = 'https://marketdataapi-production.up.railway.app/api/market-data/batch';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.POKEPULSE_MARKET_KEY
      },
      body: JSON.stringify({ productIds: [productId] })
    });
    console.log('Status:', response.status);
    const text = await response.text();
    console.log('Body:', text);
  } catch (e) {
    console.error('ERROR:', e.message);
  }
})();
