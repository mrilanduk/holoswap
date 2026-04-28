const pool = require('./db');

(async () => {
  try {
    const r1 = await pool.query(
      "SELECT set_id, local_id, name, pokepulse_set_id FROM card_index WHERE set_id='g1' AND local_id='RC28'"
    );
    console.log('card_index row for g1/RC28:');
    console.log(JSON.stringify(r1.rows, null, 2));

    const r2 = await pool.query(
      `SELECT product_id, card_name, card_number, image_url, material
       FROM pokepulse_catalogue
       WHERE set_id = 'gen' AND card_number LIKE 'RC28%'
         AND product_id LIKE '%|null|null'
       ORDER BY COALESCE(material, ''), product_id`
    );
    console.log('\npokepulse_catalogue rows for gen / RC28%:');
    console.log(JSON.stringify(r2.rows, null, 2));

    const r3 = await pool.query(
      "SELECT COUNT(*) AS n FROM card_index WHERE set_id='g1' AND local_id LIKE 'RC%' AND pokepulse_set_id='gen'"
    );
    console.log('\ng1 RC cards with pokepulse_set_id=gen:', r3.rows[0].n);
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await pool.end();
  }
})();
