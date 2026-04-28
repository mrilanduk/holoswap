const pool = require('./db');

(async () => {
  try {
    const r1 = await pool.query(
      `SELECT product_id, set_id, card_number, card_name, material
       FROM pokepulse_catalogue
       WHERE card_name ILIKE '%charizard%' AND card_number ILIKE '4/%'
       ORDER BY set_id, product_id
       LIMIT 30`
    );
    console.log('Charizard 4/* in pokepulse_catalogue:');
    console.log(JSON.stringify(r1.rows, null, 2));

    const r2 = await pool.query(
      `SELECT DISTINCT ON (COALESCE(material, ''), split_part(product_id, '|', 4))
              product_id, card_name, card_number, image_url, material,
              split_part(product_id, '|', 4) AS promo
       FROM pokepulse_catalogue
       WHERE set_id = 'bsu'
         AND product_id LIKE '%|null|null'
         AND (
           card_number LIKE '4%'
           OR (
             substring(card_number from '\\d+') IS NOT NULL
             AND substring(card_number from '\\d+')::int = 4
           )
         )
       ORDER BY COALESCE(material, ''), split_part(product_id, '|', 4), product_id`
    );
    console.log('\nfindCachedProducts(bsu, 4):');
    console.log(JSON.stringify(r2.rows, null, 2));
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await pool.end();
  }
})();
