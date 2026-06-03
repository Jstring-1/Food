// Ingest the RecipeNLG dataset (~2.2M recipes) into the recipe table.
//
//   1. Download RecipeNLG (full_dataset.csv) from:
//      https://recipenlg.cs.put.poznan.pl/   (research-licensed)
//   2. Put full_dataset.csv in ./data/recipes/  (or set RECIPENLG_FILE).
//   3. npm run db:migrate        (once, creates the recipe table)
//   4. npm run ingest:recipes:nlg
//
// Full refresh of source='recipenlg' rows only. No nutrition in this dataset.
import 'dotenv/config';
import { createReadStream, existsSync } from 'node:fs';
import { parse } from 'csv-parse';
import pgCopy from 'pg-copy-streams';
import { pool } from '../db.js';
import { row, write, end, parseList, jsonArray } from './util.js';

const { from: copyFrom } = pgCopy;
const FILE = process.env.RECIPENLG_FILE ?? './data/recipes/full_dataset.csv';

// Normalize the source link to an absolute URL when possible.
function url(link: string | undefined): string | null {
  const l = (link || '').trim();
  if (!l) return null;
  return /^https?:\/\//i.test(l) ? l : `http://${l}`;
}

async function main() {
  if (!existsSync(FILE)) throw new Error(`Missing ${FILE} (set RECIPENLG_FILE)`);
  console.log(`Ingesting RecipeNLG from ${FILE}`);

  await pool.query(`DELETE FROM recipe WHERE source = 'recipenlg'`);

  const client = await pool.connect();
  try {
    const dest = client.query(copyFrom(
      `COPY recipe (source, source_id, title, ingredients, steps, tags, source_url)
       FROM STDIN WITH (FORMAT text)`));
    const parser = createReadStream(FILE).pipe(
      parse({ columns: true, relax_quotes: true, skip_records_with_error: true }),
    );
    let n = 0;
    for await (const r of parser as AsyncIterable<Record<string, string>>) {
      const title = r.title?.trim();
      if (!title) continue;
      // The unnamed first CSV column (row index) parses as key '' under columns:true.
      const idx = r[''] ?? r.index ?? null;
      await write(dest, row(
        'recipenlg', idx, title,
        jsonArray(parseList(r.ingredients)),
        jsonArray(parseList(r.directions)),
        '[]', // RecipeNLG has no tags (its NER field is ingredient nouns)
        url(r.link),
      ));
      if (++n % 250_000 === 0) console.log(`  recipes: ${n.toLocaleString()}`);
    }
    await end(dest);
    console.log(`  recipes: ${n.toLocaleString()} (done)`);
  } finally {
    client.release();
  }

  await pool.query('ANALYZE recipe');
  await pool.end();
  console.log('RecipeNLG ingest complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
