// Ingest the Open Food Facts Parquet export into Postgres.
//
//   1. Download "food.parquet" from https://world.openfoodfacts.org/data
//   2. Point OFF_FILE at it (default ./data/food.parquet)
//   3. npm run db:migrate   (once)
//   4. npm run ingest:off
//
// DuckDB reads the Parquet and flattens its nested columns (product_name and
// ingredients_text are arrays of {lang,text}; nutriments is an array of
// nutrient structs). We stream the transformed rows and load them via Postgres
// COPY. Full refresh: off_product is truncated and reloaded.
//
// The full nutriments JSON blob is large (~8 GB across the dump). It is only
// stored when OFF_NUTRIMENTS_JSON=1; otherwise the column is left null and the
// flattened *_100g columns carry the common macros.
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import pgCopy from 'pg-copy-streams';
import { pool } from '../db.js';
import { row, write, end } from './util.js';

const require = createRequire(import.meta.url);
// duckdb ships CommonJS; load it without fighting ESM/type interop.
const duckdb = require('duckdb') as any;

const { from: copyFrom } = pgCopy;
const OFF_FILE = process.env.OFF_FILE ?? './data/food.parquet';
const INCLUDE_JSON = process.env.OFF_NUTRIMENTS_JSON === '1';

// Pick the best language variant from a STRUCT(lang,text)[] column.
const pickText = (col: string) =>
  `coalesce(((list_filter(${col}, x -> x.lang='main'))[1]).text,
            ((list_filter(${col}, x -> x.lang='en'))[1]).text,
            (${col}[1]).text)`;

// Pull one nutrient's per-100g value out of the nutriments struct array.
const per100g = (name: string) =>
  `((list_filter(nutriments, x -> x.name='${name}'))[1])."100g"`;

function transformSql(file: string): string {
  return `
    SELECT
      code,
      ${pickText('product_name')}      AS product_name,
      brands,
      categories,
      quantity,
      serving_size,
      ${pickText('ingredients_text')}  AS ingredients_text,
      nutriscore_grade,
      nova_group,
      array_to_string(countries_tags, ',') AS countries,
      ${per100g('energy-kcal')}        AS energy_kcal_100g,
      ${per100g('proteins')}           AS proteins_100g,
      ${per100g('fat')}                AS fat_100g,
      ${per100g('saturated-fat')}      AS saturated_fat_100g,
      ${per100g('carbohydrates')}      AS carbohydrates_100g,
      ${per100g('sugars')}             AS sugars_100g,
      ${per100g('fiber')}              AS fiber_100g,
      ${per100g('salt')}               AS salt_100g,
      ${per100g('sodium')}             AS sodium_100g,
      ${per100g('vitamin-d')}          AS vitamin_d_100g,
      ${per100g('calcium')}            AS calcium_100g,
      ${per100g('iron')}               AS iron_100g,
      ${per100g('potassium')}          AS potassium_100g,
      ${per100g('vitamin-c')}          AS vitamin_c_100g,
      ${INCLUDE_JSON ? 'to_json(nutriments)' : 'NULL'} AS nutriments,
      CASE WHEN last_modified_t IS NOT NULL THEN to_timestamp(last_modified_t) END AS last_modified
    FROM read_parquet('${file.replace(/\\/g, '/')}')
    WHERE code IS NOT NULL AND trim(code) <> ''
    -- code is the PK; keep one row per barcode (most recently modified)
    QUALIFY row_number() OVER (PARTITION BY code ORDER BY last_modified_t DESC NULLS LAST) = 1`;
}

const COPY_SQL = `COPY off_product (
  code, product_name, brands, categories, quantity, serving_size, ingredients_text,
  nutriscore_grade, nova_group, countries,
  energy_kcal_100g, proteins_100g, fat_100g, saturated_fat_100g, carbohydrates_100g,
  sugars_100g, fiber_100g, salt_100g, sodium_100g,
  vitamin_d_100g, calcium_100g, iron_100g, potassium_100g, vitamin_c_100g,
  nutriments, last_modified
) FROM STDIN WITH (FORMAT text)`;

function toLine(r: any): string {
  return row(
    r.code,
    r.product_name,
    r.brands,
    r.categories,
    r.quantity,
    r.serving_size,
    r.ingredients_text,
    r.nutriscore_grade,
    r.nova_group,
    r.countries,
    r.energy_kcal_100g,
    r.proteins_100g,
    r.fat_100g,
    r.saturated_fat_100g,
    r.carbohydrates_100g,
    r.sugars_100g,
    r.fiber_100g,
    r.salt_100g,
    r.sodium_100g,
    r.vitamin_d_100g,
    r.calcium_100g,
    r.iron_100g,
    r.potassium_100g,
    r.vitamin_c_100g,
    r.nutriments,
    r.last_modified,
  );
}

async function main() {
  if (!existsSync(OFF_FILE)) throw new Error(`Missing OFF Parquet at ${OFF_FILE}`);
  console.log(`Ingesting Open Food Facts from ${OFF_FILE}`);
  console.log(`  full nutriments JSON: ${INCLUDE_JSON ? 'ON' : 'off (set OFF_NUTRIMENTS_JSON=1 to include)'}`);

  await pool.query('TRUNCATE off_product');

  const db = new duckdb.Database(':memory:');
  const con = db.connect();
  const client = await pool.connect();
  try {
    const dest = client.query(copyFrom(COPY_SQL));
    const stream = con.stream(transformSql(OFF_FILE));
    let n = 0;
    for await (const r of stream as AsyncIterable<any>) {
      await write(dest, toLine(r));
      if (++n % 100_000 === 0) console.log(`  products: ${n.toLocaleString()}`);
    }
    await end(dest);
    console.log(`  products: ${n.toLocaleString()} (done)`);
  } finally {
    client.release();
    db.close(() => {});
  }

  await pool.end();
  console.log('OFF ingest complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
