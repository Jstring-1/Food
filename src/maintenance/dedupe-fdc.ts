// Deduplicate FDC branded foods by barcode (gtin_upc).
//
// FDC republishes the same branded product over time — identical brand and
// gtin_upc, different publication_date. We keep ONE row per barcode: prefer an
// entry that has nutrient data, then the most recent. Cascades remove the
// redundant fdc_branded and fdc_food_nutrient rows (ON DELETE CASCADE).
//
// Non-branded foods and rows without a gtin_upc are left untouched.
//
//   npm run dedupe:fdc
import { pool } from '../db.js';

async function count(sql: string): Promise<number> {
  const { rows } = await pool.query(sql);
  return Number(rows[0].n);
}

async function main() {
  const before = await count('SELECT count(*)::bigint n FROM fdc_food');
  console.log(`fdc_food before: ${before.toLocaleString()}`);

  console.log('Ranking branded rows by barcode (this scans food_nutrient once)…');
  const res = await pool.query(`
    WITH has_n AS (SELECT DISTINCT fdc_id FROM fdc_food_nutrient),
    ranked AS (
      SELECT f.fdc_id,
             row_number() OVER (
               PARTITION BY b.gtin_upc
               ORDER BY (hn.fdc_id IS NOT NULL) DESC,
                        f.publication_date DESC NULLS LAST,
                        f.fdc_id DESC
             ) AS rn
        FROM fdc_food f
        JOIN fdc_branded b ON b.fdc_id = f.fdc_id
        LEFT JOIN has_n hn ON hn.fdc_id = f.fdc_id
       WHERE b.gtin_upc IS NOT NULL AND b.gtin_upc <> ''
    )
    DELETE FROM fdc_food
     WHERE fdc_id IN (SELECT fdc_id FROM ranked WHERE rn > 1)`);
  console.log(`deleted duplicate branded foods: ${(res.rowCount ?? 0).toLocaleString()}`);

  const after = await count('SELECT count(*)::bigint n FROM fdc_food');
  console.log(`fdc_food after:  ${after.toLocaleString()}`);

  console.log('VACUUM ANALYZE (reclaim + refresh planner stats)…');
  await pool.query('VACUUM ANALYZE fdc_food');
  await pool.query('VACUUM ANALYZE fdc_branded');
  await pool.query('VACUUM ANALYZE fdc_food_nutrient');

  await pool.end();
  console.log('Dedupe complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
