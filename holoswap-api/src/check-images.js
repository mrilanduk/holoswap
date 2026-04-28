const pool = require('./db');

(async () => {
  try {
    const r1 = await pool.query(
      "SELECT product_id, set_id, card_number, card_name FROM pokepulse_catalogue WHERE card_name ILIKE '%flareon%' AND card_number ILIKE '%28%' LIMIT 10"
    );
    console.log('Flareon-ish rows in pokepulse_catalogue:');
    console.log(JSON.stringify(r1.rows, null, 2));

    const r2 = await pool.query(
      "SELECT DISTINCT set_id FROM pokepulse_catalogue WHERE card_number ILIKE 'rc%' ORDER BY set_id LIMIT 20"
    );
    console.log('\nDistinct PokePulse set_ids that contain RC-prefixed cards:');
    console.log(JSON.stringify(r2.rows, null, 2));

    const r3 = await pool.query(
      "SELECT COUNT(*) AS n FROM pokepulse_catalogue WHERE set_id = 'g1'"
    );
    console.log('\nRows in pokepulse_catalogue with set_id=g1:', r3.rows[0].n);
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await pool.end();
  }
})();
