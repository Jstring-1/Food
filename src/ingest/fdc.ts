// Ingest a USDA FoodData Central "Full Download" CSV dump into Postgres.
//
//   1. Download the CSV full export: https://fdc.nal.usda.gov/download-datasets
//   2. Unzip it into FDC_DIR (default ./data/fdc) so the .csv files sit directly inside.
//   3. npm run db:migrate   (once)
//   4. npm run ingest:fdc
//
// This is a full refresh: existing fdc_* rows are truncated and reloaded.
import 'dotenv/config';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse';
import pgCopy from 'pg-copy-streams';
import { pool } from '../db.js';
import { row, write, end } from './util.js';

const { from: copyFrom } = pgCopy;
const FDC_DIR = process.env.FDC_DIR ?? './data/fdc';

function file(name: string): string {
  const p = join(FDC_DIR, name);
  if (!existsSync(p)) throw new Error(`Missing ${name} in ${FDC_DIR}`);
  return p;
}

// Stream a CSV (header mode) and COPY it into Postgres. `mapRow` turns one
// parsed record into a COPY line, or returns null to skip it.
async function loadCsv(
  copySql: string,
  csvPath: string,
  mapRow: (rec: Record<string, string>) => string | null,
  label: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    const dest = client.query(copyFrom(copySql));
    const parser = createReadStream(csvPath).pipe(
      parse({ columns: true, relax_quotes: true, skip_records_with_error: true }),
    );
    let n = 0;
    for await (const rec of parser as AsyncIterable<Record<string, string>>) {
      const line = mapRow(rec);
      if (line === null) continue;
      await write(dest, line);
      if (++n % 250_000 === 0) console.log(`  ${label}: ${n.toLocaleString()}`);
    }
    await end(dest);
    console.log(`  ${label}: ${n.toLocaleString()} (done)`);
  } finally {
    client.release();
  }
}

async function loadCategories(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const parser = createReadStream(file('food_category.csv')).pipe(
    parse({ columns: true, relax_quotes: true, skip_records_with_error: true }),
  );
  for await (const rec of parser as AsyncIterable<Record<string, string>>) {
    if (rec.id) map.set(rec.id, rec.description ?? '');
  }
  return map;
}

async function main() {
  console.log(`Ingesting FDC dump from ${FDC_DIR}`);

  await pool.query(
    'TRUNCATE fdc_food_nutrient, fdc_branded, fdc_food, fdc_nutrient RESTART IDENTITY CASCADE',
  );

  await loadCsv(
    'COPY fdc_nutrient (id, name, unit_name, nutrient_nbr) FROM STDIN WITH (FORMAT text)',
    file('nutrient.csv'),
    (r) => row(r.id, r.name, r.unit_name, r.nutrient_nbr),
    'nutrient',
  );

  const categories = await loadCategories();
  await loadCsv(
    'COPY fdc_food (fdc_id, data_type, description, food_category, publication_date) FROM STDIN WITH (FORMAT text)',
    file('food.csv'),
    (r) =>
      row(
        r.fdc_id,
        r.data_type,
        r.description,
        r.food_category_id ? categories.get(r.food_category_id) ?? null : null,
        r.publication_date,
      ),
    'food',
  );

  await loadCsv(
    'COPY fdc_branded (fdc_id, brand_owner, brand_name, gtin_upc, ingredients, serving_size, serving_size_unit, household_serving, branded_food_category) FROM STDIN WITH (FORMAT text)',
    file('branded_food.csv'),
    (r) =>
      row(
        r.fdc_id,
        r.brand_owner,
        r.brand_name,
        r.gtin_upc,
        r.ingredients,
        r.serving_size,
        r.serving_size_unit,
        r.household_serving_fulltext,
        r.branded_food_category,
      ),
    'branded',
  );

  // The big one — millions of rows. We only keep fdc_id, nutrient_id, amount.
  await loadCsv(
    'COPY fdc_food_nutrient (fdc_id, nutrient_id, amount) FROM STDIN WITH (FORMAT text)',
    file('food_nutrient.csv'),
    (r) => (r.fdc_id && r.nutrient_id ? row(r.fdc_id, r.nutrient_id, r.amount) : null),
    'food_nutrient',
  );

  await pool.end();
  console.log('FDC ingest complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
