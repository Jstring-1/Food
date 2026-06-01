// Ingest the Open Food Facts JSONL dump into Postgres.
//
//   1. Download: https://world.openfoodfacts.org/data
//      -> "openfoodfacts-products.jsonl.gz"  (do NOT gunzip; we stream it)
//   2. Point OFF_FILE at it (default ./data/openfoodfacts-products.jsonl.gz)
//   3. npm run db:migrate   (once)
//   4. npm run ingest:off
//
// Full refresh: off_product is truncated and reloaded. The dump is large
// (tens of GB uncompressed) — this streams line by line, never loading it all.
import 'dotenv/config';
import { createReadStream, existsSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import pgCopy from 'pg-copy-streams';
import { pool } from '../db.js';
import { row, write, end } from './util.js';

const { from: copyFrom } = pgCopy;
const OFF_FILE = process.env.OFF_FILE ?? './data/openfoodfacts-products.jsonl.gz';

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

async function main() {
  if (!existsSync(OFF_FILE)) throw new Error(`Missing OFF dump at ${OFF_FILE}`);
  console.log(`Ingesting Open Food Facts dump from ${OFF_FILE}`);

  await pool.query('TRUNCATE off_product');

  const client = await pool.connect();
  try {
    const dest = client.query(
      copyFrom(
        'COPY off_product (code, product_name, brands, categories, quantity, serving_size, ingredients_text, nutriscore_grade, nova_group, countries, nutriments, last_modified) FROM STDIN WITH (FORMAT text)',
      ),
    );

    const rl = createInterface({
      input: createReadStream(OFF_FILE).pipe(createGunzip()),
      crlfDelay: Infinity,
    });

    let n = 0;
    let skipped = 0;
    for await (const line of rl) {
      if (!line) continue;
      let p: any;
      try {
        p = JSON.parse(line);
      } catch {
        skipped++;
        continue;
      }
      if (!p.code) {
        skipped++;
        continue;
      }
      const lastModified =
        p.last_modified_t != null ? new Date(Number(p.last_modified_t) * 1000).toISOString() : null;

      await write(
        dest,
        row(
          p.code,
          p.product_name,
          p.brands,
          p.categories,
          p.quantity,
          p.serving_size,
          p.ingredients_text,
          p.nutriscore_grade,
          toInt(p.nova_group),
          p.countries,
          JSON.stringify(p.nutriments ?? {}),
          lastModified,
        ),
      );
      if (++n % 100_000 === 0) console.log(`  products: ${n.toLocaleString()}`);
    }

    await end(dest);
    console.log(`  products: ${n.toLocaleString()} (done, ${skipped.toLocaleString()} skipped)`);
  } finally {
    client.release();
  }

  await pool.end();
  console.log('OFF ingest complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
