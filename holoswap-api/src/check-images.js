const pool = require('./db');

(async () => {
  try {
    const r = await pool.query(
      "SELECT product_id, set_id, card_number, card_name FROM pokepulse_catalogue WHERE card_name ILIKE '%zekrom%' ORDER BY set_id, card_number LIMIT 10"
    );
    console.log('Zekrom rows in pokepulse_catalogue:');
    console.log(JSON.stringify(r.rows, null, 2));

    const r2 = await pool.query(
      "SELECT product_id, set_id, card_number, card_name FROM pokepulse_catalogue WHERE set_id IN ('me02', 'pf') ORDER BY card_number LIMIT 10"
    );
    console.log('\nSample rows for set_id me02 / pf:');
    console.log(JSON.stringify(r2.rows, null, 2));
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await pool.end();
  }
})();
