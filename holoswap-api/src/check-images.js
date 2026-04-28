const pool = require('./db');

(async () => {
  try {
    // Find all RC-style local_ids in card_index
    const rcRows = await pool.query(
      `SELECT set_id, set_name, local_id, name
       FROM card_index
       WHERE local_id ILIKE '%rc%' OR local_id ILIKE 'rc%' OR name ILIKE 'flareon%'
       ORDER BY set_id, local_id
       LIMIT 30`
    );
    console.log('RC-ish local_ids / Flareon rows:');
    console.log(JSON.stringify(rcRows.rows, null, 2));

    // What does Generations look like specifically?
    const g1 = await pool.query(
      `SELECT local_id, name, set_id
       FROM card_index
       WHERE set_id = 'g1'
       ORDER BY LPAD(REGEXP_REPLACE(local_id, '\\D', '', 'g'), 5, '0'), local_id
       LIMIT 5 OFFSET 80`
    );
    console.log('\nGenerations rows 80-85 (where RC cards should start):');
    console.log(JSON.stringify(g1.rows, null, 2));

    // Direct search for RC28 using the same query pattern as vending.js prefixed_number
    const lookup = await pool.query(
      `SELECT * FROM card_index WHERE UPPER(local_id) = UPPER($1)
       AND set_id IN (SELECT set_id FROM card_index WHERE UPPER(local_id) = UPPER($2))
       ORDER BY set_id`,
      ['RC28', 'RC32']
    );
    console.log('\nVending lookup for RC28/RC32:', lookup.rows.length, 'rows');
    console.log(JSON.stringify(lookup.rows.map(r => ({set_id: r.set_id, local_id: r.local_id, name: r.name})), null, 2));
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await pool.end();
  }
})();
