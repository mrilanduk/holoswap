const pool = require('./db');

(async () => {
  try {
    const a = await pool.query(
      "SELECT COUNT(*) AS n FROM card_index WHERE set_id = 'mep' AND image_url IS NULL"
    );
    const b = await pool.query(
      "SELECT COUNT(*) AS n FROM pokepulse_catalogue WHERE set_id = 'mep' AND image_url IS NOT NULL"
    );
    const c = await pool.query(
      `SELECT ci.local_id, ci.pokepulse_set_id, ci.image_url AS ci_img,
              pp.card_number, pp.set_id AS pp_set_id, pp.image_url AS pp_img
       FROM card_index ci
       LEFT JOIN pokepulse_catalogue pp
         ON ci.pokepulse_set_id = pp.set_id AND ci.local_id = pp.card_number
       WHERE ci.set_id = 'mep'
       ORDER BY ci.local_id
       LIMIT 5`
    );
    console.log('card_index mep rows missing image:', a.rows[0].n);
    console.log('pokepulse_catalogue mep rows with image:', b.rows[0].n);
    console.log('join sample:');
    console.log(JSON.stringify(c.rows, null, 2));
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await pool.end();
  }
})();
