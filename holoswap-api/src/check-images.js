const pool = require('./db');

(async () => {
  try {
    const r1 = await pool.query(
      `SELECT product_id, set_id, card_number, card_name, material
       FROM pokepulse_catalogue
       WHERE set_id = 'mep' AND substring(card_number from '\\d+')::int = 31
       ORDER BY product_id`
    );
    console.log('All mep #31 rows in pokepulse_catalogue:');
    console.log(JSON.stringify(r1.rows, null, 2));

    const r2 = await pool.query(
      `SELECT DISTINCT ON (COALESCE(material, ''), split_part(product_id, '|', 4))
              product_id, card_name, card_number, image_url, material,
              split_part(product_id, '|', 4) AS promo
       FROM pokepulse_catalogue
       WHERE set_id = 'mep'
         AND product_id LIKE '%|null|null'
         AND (
           card_number LIKE '31%'
           OR (
             substring(card_number from '\\d+') IS NOT NULL
             AND substring(card_number from '\\d+')::int = 31
           )
         )
       ORDER BY COALESCE(material, ''), split_part(product_id, '|', 4), product_id`
    );
    console.log('\nfindCachedProducts(mep, 31) result:');
    console.log(JSON.stringify(r2.rows, null, 2));
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await pool.end();
  }
})();
