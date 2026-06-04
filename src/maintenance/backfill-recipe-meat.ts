// Backfill the precomputed vegetarian flag (recipe.has_meat).
//
//   true  = ingredients mention meat/fish/shellfish (see NONVEG_TERMS)
//   false = none found (vegetarian-safe by ingredients)
//   NULL  = no ingredient list, so we can't tell
//
// The recipe-page vegetarian filter reads this column instead of recomputing the
// ingredient full-text match per row (which is far too slow over large result
// sets). Safe to re-run; run after either recipe ingest.
//   npm run backfill:recipe-meat
import 'dotenv/config';
import { pool } from '../db.js';
import { ING_TSV, NONVEG_TSQUERY } from '../recipe-filters.js';

async function main() {
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 0');
    console.log('Computing has_meat for all recipes (one heavy pass)...');
    const t0 = Date.now();
    const r = await client.query(
      `UPDATE recipe SET has_meat = CASE
         WHEN ingredients IS NULL OR jsonb_array_length(ingredients) = 0 THEN NULL
         WHEN ${ING_TSV} @@ to_tsquery('english', $1) THEN true
         ELSE false
       END`,
      [NONVEG_TSQUERY]);
    console.log(`Updated ${r.rowCount} rows in ${Math.round((Date.now() - t0) / 1000)}s`);
    const c = await client.query(
      `SELECT count(*) FILTER (WHERE has_meat) meat,
              count(*) FILTER (WHERE has_meat = false) veg,
              count(*) FILTER (WHERE has_meat IS NULL) unknown FROM recipe`);
    console.log('Breakdown:', c.rows[0]);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
