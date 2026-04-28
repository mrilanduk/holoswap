const pool = require('./db');

(async () => {
  try {
    const cardNumber = '10';
    const total = '105';
    const totalInt = parseInt(total, 10);

    const matches = await pool.query(
      `SELECT ci.set_id, ci.set_name, ci.set_total, ci.local_id, ci.name
       FROM card_index ci
       WHERE (ci.local_id = $1 OR ci.local_id = $2)
         AND ci.set_total BETWEEN $3 AND $4
         AND ci.set_id IN (
           SELECT set_id FROM card_index
           WHERE (local_id = $5 OR local_id = $6)
             AND set_total BETWEEN $3 AND $4
         )
       ORDER BY ci.set_id`,
      [cardNumber, cardNumber.padStart(3, '0'), totalInt, totalInt + 30, total, total.padStart(3, '0')]
    );
    console.log(`Matches for ${cardNumber}/${total}: ${matches.rows.length}`);
    console.log(JSON.stringify(matches.rows, null, 2));

    const totals = await pool.query(
      `SELECT DISTINCT set_id, set_name, set_total
       FROM card_index
       WHERE set_total BETWEEN $1 AND $2
       ORDER BY set_total, set_id`,
      [totalInt, totalInt + 30]
    );
    console.log(`\nAll sets with set_total in [${totalInt}, ${totalInt + 30}]: ${totals.rows.length}`);
    console.log(JSON.stringify(totals.rows, null, 2));
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await pool.end();
  }
})();
