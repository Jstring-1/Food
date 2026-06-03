// Backfill full Food.com ingredient lines (with units) from RecipeNLG.
//
// The Food.com dataset stores ingredient quantity + name in separate columns
// and drops the unit ("1/2 cup mayonnaise" -> "1/2" + "mayonnaise"). But the
// same recipes appear in RecipeNLG with the full original ingredient line and a
// food.com source link carrying the recipe id. Match by id and replace.
//
// Safe to re-run (idempotent); run after either recipe ingest.
//   npm run backfill:recipe-units
import 'dotenv/config';
import { pool } from '../db.js';

async function main() {
  const client = await pool.connect(); // one session so the TEMP TABLE persists
  try {
    console.log('Building food.com id -> RecipeNLG ingredients map...');
    await client.query('DROP TABLE IF EXISTS _fc_units');
    await client.query(`
      CREATE TEMP TABLE _fc_units AS
      SELECT DISTINCT ON (fid) fid, ingredients
        FROM (
          SELECT (regexp_match(source_url, '-(\\d+)/?$'))[1] AS fid, ingredients
            FROM recipe
           WHERE source = 'recipenlg'
             AND source_url ILIKE '%food.com/recipe/%'
             AND ingredients IS NOT NULL
             AND jsonb_array_length(ingredients) > 0
        ) t
       WHERE fid IS NOT NULL
       ORDER BY fid, jsonb_array_length(ingredients) DESC`);
    const m = await client.query('SELECT count(*)::int n FROM _fc_units');
    console.log(`mapped food.com ids: ${m.rows[0].n.toLocaleString()}`);

    console.log('Updating Food.com recipes with full ingredient lines...');
    const u = await client.query(`
      UPDATE recipe f
         SET ingredients = m.ingredients,
             n_ingredients = jsonb_array_length(m.ingredients)
        FROM _fc_units m
       WHERE f.source = 'foodcom' AND f.source_id = m.fid`);
    console.log(`backfilled recipes: ${(u.rowCount ?? 0).toLocaleString()}`);

    await client.query('ANALYZE recipe');
  } finally {
    client.release();
  }
  await pool.end();
  console.log('Backfill complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
