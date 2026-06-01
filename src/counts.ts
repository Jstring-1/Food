// Quick sanity check after ingestion: row counts per table.
import { pool } from './db.js';

const tables = [
  'fdc_food',
  'fdc_nutrient',
  'fdc_food_nutrient',
  'fdc_branded',
  'off_product',
];

async function main() {
  for (const t of tables) {
    const { rows } = await pool.query(`SELECT count(*)::bigint AS n FROM ${t}`);
    console.log(`${t.padEnd(20)} ${Number(rows[0].n).toLocaleString()}`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
