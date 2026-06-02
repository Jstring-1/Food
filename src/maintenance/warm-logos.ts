// Pre-warm the brand-logo cache so results render instantly instead of each
// brand's first viewer paying a live Brandfetch call mid-request.
//
// Logos are cached permanently in brand_logos (including null misses, so we
// never re-hit Brandfetch for a brand). This script just front-loads the most
// common brands. Safe to re-run: already-cached brands are skipped.
//
//   npm run warm:logos            # default top 1500 brands
//   LOGO_WARM_LIMIT=5000 npm run warm:logos
import { pool } from '../db.js';
import { resolveLogo, brandKey } from '../logo.js';

const BF_TOKEN = process.env.BRANDFETCH_API_TOKEN;
const LIMIT = Number(process.env.LOGO_WARM_LIMIT ?? 1500);
const DELAY_MS = Number(process.env.LOGO_WARM_DELAY_MS ?? 300);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function topBrands(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT brand, sum(n) n FROM (
        SELECT split_part(brands, ',', 1) AS brand, count(*) n
          FROM off_product WHERE brands <> '' GROUP BY 1
        UNION ALL
        SELECT coalesce(NULLIF(brand_name, ''), brand_owner) AS brand, count(*) n
          FROM fdc_branded
         WHERE coalesce(NULLIF(brand_name, ''), brand_owner) IS NOT NULL
           AND coalesce(NULLIF(brand_name, ''), brand_owner) <> ''
         GROUP BY 1
     ) t
     WHERE brand IS NOT NULL AND brand <> ''
     GROUP BY brand
     ORDER BY n DESC
     LIMIT $1`, [LIMIT]);
  return rows.map((r) => String(r.brand).trim()).filter(Boolean);
}

async function main() {
  if (!BF_TOKEN) console.warn('No BRANDFETCH_API_TOKEN set — real logos need it; run this on Railway.');

  const cached = new Set<string>(
    (await pool.query('SELECT brand_key FROM brand_logos')).rows.map((r) => r.brand_key));

  const brands = await topBrands();
  const todo: { brand: string; key: string }[] = [];
  const seen = new Set<string>();
  for (const brand of brands) {
    const key = brandKey(brand);
    if (!key || cached.has(key) || seen.has(key)) continue;
    seen.add(key);
    todo.push({ brand, key });
  }

  console.log(`top brands: ${brands.length}, already cached: ${cached.size}, to fetch: ${todo.length}`);
  let hits = 0;
  for (let i = 0; i < todo.length; i++) {
    const { brand, key } = todo[i];
    const url = await resolveLogo(brand, BF_TOKEN);
    await pool.query(
      `INSERT INTO brand_logos (brand_key, logo_url) VALUES ($1, $2)
       ON CONFLICT (brand_key) DO UPDATE SET logo_url = EXCLUDED.logo_url, fetched_at = now()`,
      [key, url]);
    if (url) hits++;
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${todo.length} (${hits} logos found)`);
    await sleep(DELAY_MS);
  }

  console.log(`Done. Fetched ${todo.length} brands, ${hits} had logos.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
