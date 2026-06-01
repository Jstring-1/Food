// Load glycemic-index reference values into gi_values.
//
//   npm run ingest:gi
//
// Always loads the curated seed (src/data/gi-seed.ts). If GI_CSV points to a
// CSV (e.g. the published 2021 International Tables export with columns
// name,gi[,category]), those rows are merged in too. Keywords are taken from
// the seed or auto-derived from the food name.
import 'dotenv/config';
import { createReadStream, existsSync } from 'node:fs';
import { parse } from 'csv-parse';
import { pool } from '../db.js';
import { GI_SEED } from '../data/gi-seed.js';

const GI_CSV = process.env.GI_CSV;
const STOP = new Set(['raw', 'cooked', 'boiled', 'baked', 'fresh', 'and', 'with', 'the', 'of', 'in',
  'or', 'a', 'whole', 'fat', 'low', 'plain', 'dried', 'canned', 'frozen', 'average', 'mean']);

function deriveKeywords(name: string): string[] {
  const toks = name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
  return [...new Set(toks)].slice(0, 3);
}

const category = (gi: number) => (gi <= 55 ? 'low' : gi <= 69 ? 'medium' : 'high');

type Row = { name: string; gi: number; keywords: string[]; source: string };

async function loadCsv(path: string): Promise<Row[]> {
  const out: Row[] = [];
  const parser = createReadStream(path).pipe(parse({ columns: true, skip_empty_lines: true, trim: true }));
  for await (const r of parser as AsyncIterable<Record<string, string>>) {
    const gi = Math.round(Number(r.gi ?? r.GI));
    const name = r.name ?? r.Name ?? r.food;
    if (!name || !Number.isFinite(gi)) continue;
    const keywords = r.keywords ? r.keywords.split('|').map((k) => k.trim().toLowerCase()).filter(Boolean) : deriveKeywords(name);
    if (keywords.length) out.push({ name, gi, keywords, source: 'GI_CSV' });
  }
  return out;
}

async function main() {
  const rows: Row[] = GI_SEED.map((s) => ({ name: s.name, gi: s.gi, keywords: s.keywords, source: 'Curated (published GI tables)' }));
  if (GI_CSV && existsSync(GI_CSV)) {
    const extra = await loadCsv(GI_CSV);
    rows.push(...extra);
    console.log(`Loaded ${extra.length} rows from ${GI_CSV}`);
  }

  await pool.query('TRUNCATE gi_values RESTART IDENTITY');
  for (const r of rows) {
    await pool.query(
      'INSERT INTO gi_values (name, gi, category, source, keywords) VALUES ($1,$2,$3,$4,$5)',
      [r.name, r.gi, category(r.gi), r.source, r.keywords],
    );
  }
  await pool.end();
  console.log(`gi_values loaded: ${rows.length} entries.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
