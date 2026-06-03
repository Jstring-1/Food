import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import express from 'express';
import { pool } from './db.js';
import { resolveLogo, brandKey } from './logo.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SHELL = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
const ORIGIN = process.env.SITE_ORIGIN || 'https://foodland.fyi';

// Cache-bust client assets per deploy so browsers never run a stale app.js.
const ASSET_V = Date.now().toString(36);
const stamp = (html: string) =>
  html.replace(/(\/(?:app\.js|styles\.css|additives\.js))(?=["'])/g, `$1?v=${ASSET_V}`);

app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
}));

app.get('/', (_req, res) => res.type('html').set('Cache-Control', 'no-cache').send(stamp(SHELL)));
app.get('/favicon.ico', (_req, res) => res.redirect(301, '/favicon.svg'));
// Recipe-page base URL (SPA shows the recipe page; direct visits/refresh work).
app.get('/recipes', (_req, res) => res.type('html').set('Cache-Control', 'no-cache').send(stamp(SHELL)));

function escHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// Public JSON API: permissive CORS + a light per-IP fixed-window rate limit.
const RATE = new Map<string, { n: number; t: number }>();
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'x';
  const now = Date.now();
  if (RATE.size > 20000) RATE.clear(); // crude memory cap
  const slot = RATE.get(ip);
  if (!slot || now - slot.t > 60_000) RATE.set(ip, { n: 1, t: now });
  else if (slot.n >= 120) return void res.status(429).json({ error: 'rate limit: 120 requests/minute' });
  else slot.n++;
  next();
});

// Liveness probe — never touches the DB.
app.get('/health', (_req, res) => res.json({ ok: true }));

// Row counts for the landing header.
app.get('/api/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM fdc_food)    AS usda,
              (SELECT count(*) FROM off_product) AS off`,
    );
    res.json({ usda: Number(rows[0].usda), off: Number(rows[0].off) });
  } catch {
    res.json({ usda: 0, off: 0, error: 'database not ready' });
  }
});

// Brand logo lookup (resolved once per brand, then cached in the DB).
const BF_TOKEN = process.env.BRANDFETCH_API_TOKEN;

app.get('/api/logo', async (req, res) => {
  const brand = String(req.query.brand ?? '').trim();
  const key = brandKey(brand);
  if (!key) return void res.json({ url: null });
  try {
    const cached = await pool.query('SELECT logo_url FROM brand_logos WHERE brand_key = $1', [key]);
    if (cached.rowCount) return void res.json({ url: cached.rows[0].logo_url });

    const url = await resolveLogo(brand, BF_TOKEN);
    await pool.query(
      `INSERT INTO brand_logos (brand_key, logo_url) VALUES ($1, $2)
       ON CONFLICT (brand_key) DO UPDATE SET logo_url = EXCLUDED.logo_url, fetched_at = now()`,
      [key, url]);
    res.json({ url });
  } catch {
    res.json({ url: null });
  }
});

const numOrNull = (v: unknown) => {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) ? null : n;
};

// Push >= / <= bounds for a column onto a params array, returning SQL fragments.
function range(col: string, min: number | null, max: number | null, params: unknown[]): string[] {
  const out: string[] = [];
  if (min != null) { params.push(min); out.push(`${col} >= $${params.length}`); }
  if (max != null) { params.push(max); out.push(`${col} <= $${params.length}`); }
  return out;
}

const ORDER = {
  usda: { name: 'f.description ASC', kcal_desc: 'kcal DESC NULLS LAST', kcal_asc: 'kcal ASC NULLS LAST', protein_desc: 'protein DESC NULLS LAST', relevance: 'f.description ASC' },
  off: { name: 'product_name ASC', kcal_desc: 'kcal DESC NULLS LAST', kcal_asc: 'kcal ASC NULLS LAST', protein_desc: 'protein DESC NULLS LAST', relevance: 'product_name ASC' },
} as const;

// In-memory LRU+TTL cache for search responses. Common/repeated/paged queries
// (and shared links) return instantly without touching the DB — which also
// means a cold-cache term is only slow once. Keyed by the full request URL.
const SEARCH_CACHE = new Map<string, { t: number; data: unknown }>();
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 1000;
function cacheGet(key: string): unknown | null {
  const e = SEARCH_CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.t > CACHE_TTL) { SEARCH_CACHE.delete(key); return null; }
  SEARCH_CACHE.delete(key); SEARCH_CACHE.set(key, e); // bump to most-recent
  return e.data;
}
function cacheSet(key: string, data: unknown): void {
  SEARCH_CACHE.set(key, { t: Date.now(), data });
  if (SEARCH_CACHE.size > CACHE_MAX) SEARCH_CACHE.delete(SEARCH_CACHE.keys().next().value as string);
}

app.get('/api/search', async (req, res) => {
  const cached = cacheGet('s:' + req.originalUrl);
  if (cached) return void res.json(cached);
  const q = String(req.query.q ?? '').trim();
  const source = String(req.query.source ?? 'all'); // all | usda | off
  const usdaType = String(req.query.usdaType ?? 'all'); // all | branded | whole
  const nutriscore = String(req.query.nutriscore ?? 'all'); // all | a..e
  const sort = (['name', 'kcal_desc', 'kcal_asc', 'protein_desc', 'relevance'].includes(String(req.query.sort)) ? String(req.query.sort) : 'relevance') as keyof typeof ORDER.usda;
  const hideEmpty = String(req.query.hideEmpty ?? '1') !== '0';
  const minKcal = numOrNull(req.query.minKcal), maxKcal = numOrNull(req.query.maxKcal);
  const minProtein = numOrNull(req.query.minProtein), maxProtein = numOrNull(req.query.maxProtein);
  const minSugar = numOrNull(req.query.minSugar), maxSugar = numOrNull(req.query.maxSugar);
  const minFat = numOrNull(req.query.minFat), maxFat = numOrNull(req.query.maxFat);
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 40));
  const offset = Math.min(400, Math.max(0, Number(req.query.offset) || 0));
  const want = offset + limit;
  // Over-fetch so grouping/dedup still leaves enough for the requested page.
  const usdaCap = Math.min(800, want * 2 + 60);
  const offCap = Math.min(500, want * 2 + 20);

  const isBarcode = /^\d{6,14}$/.test(q);
  if (!isBarcode && q.length < 3) {
    return void res.status(400).json({ error: 'query must be at least 3 characters' });
  }

  try {
    // ── Barcode lookup: exact match on OFF code + USDA gtin_upc ──
    if (isBarcode) {
      const bc: any[] = [];
      if (source !== 'off') {
        const r = await pool.query(
          `SELECT f.fdc_id, f.description FROM fdc_branded b JOIN fdc_food f ON f.fdc_id=b.fdc_id
            WHERE b.gtin_upc = $1 LIMIT 25`, [q]);
        bc.push(...r.rows.map((x) => ({ source: 'usda', id: String(x.fdc_id), title: x.description, sub: `barcode ${q}`, variantCount: 1 })));
      }
      if (source !== 'usda') {
        const r = await pool.query(
          `SELECT code, product_name, brands FROM off_product WHERE code = $1 LIMIT 25`, [q]);
        bc.push(...r.rows.map((x) => ({ source: 'off', id: x.code, title: x.product_name || '(unnamed)', sub: x.brands || `barcode ${q}`, variantCount: 1 })));
      }
      const bcPayload = { results: bc, mode: 'barcode', hasMore: false };
      cacheSet('s:' + req.originalUrl, bcPayload);
      return void res.json(bcPayload);
    }

    const like = `%${q}%`;
    const tasks: Promise<void>[] = [];
    const usdaRows: any[] = [];
    const offRows: any[] = [];

    // ── USDA ── (fetch extra so post-grouping still yields a full page)
    if (source !== 'off') {
      const p: unknown[] = [like];
      const where = ['f.description ILIKE $1'];
      if (usdaType === 'branded') where.push(`f.data_type = 'branded_food'`);
      if (usdaType === 'whole') where.push(`f.data_type <> 'branded_food'`);
      where.push(...range('f.energy_kcal_100g', minKcal, maxKcal, p));
      where.push(...range('f.protein_100g', minProtein, maxProtein, p));
      where.push(...range('f.sugars_100g', minSugar, maxSugar, p));
      where.push(...range('f.fat_100g', minFat, maxFat, p));
      if (hideEmpty) where.push('f.energy_kcal_100g IS NOT NULL');
      // Relevance: prefix match, then whole/foundation foods over branded,
      // then shortest (most generic) name — so canonical foods surface first.
      let orderBy: string = ORDER.usda[sort];
      if (sort === 'relevance') {
        p.push(q + '%');
        orderBy = `(f.description ILIKE $${p.length}) DESC,
          CASE f.data_type WHEN 'foundation_food' THEN 0 WHEN 'sr_legacy_food' THEN 0
                           WHEN 'survey_fndds_food' THEN 2 WHEN 'branded_food' THEN 4 ELSE 3 END ASC,
          length(f.description) ASC, f.description ASC`;
      }
      const sql = `
        SELECT f.fdc_id, f.description, f.data_type, f.food_category, b.branded_food_category,
               (f.data_type <> 'branded_food') AS whole,
               f.energy_kcal_100g kcal, f.protein_100g protein, f.sugars_100g sugars, f.fat_100g fat,
               coalesce(b.brand_name, b.brand_owner) AS brand,
               b.serving_size, b.serving_size_unit, b.household_serving FROM fdc_food f
        LEFT JOIN fdc_branded b ON b.fdc_id = f.fdc_id
        WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ${usdaCap}`;
      tasks.push(pool.query(sql, p).then((r) => { usdaRows.push(...r.rows); }));
    }

    // ── OFF ── (already one row per barcode; no grouping needed)
    if (source !== 'usda') {
      const p: unknown[] = [like];
      const where = ['product_name ILIKE $1', 'product_name IS NOT NULL'];
      if (/^[a-e]$/.test(nutriscore)) { p.push(nutriscore); where.push(`nutriscore_grade = $${p.length}`); }
      where.push(...range('energy_kcal_100g', minKcal, maxKcal, p));
      where.push(...range('proteins_100g', minProtein, maxProtein, p));
      where.push(...range('sugars_100g', minSugar, maxSugar, p));
      where.push(...range('fat_100g', minFat, maxFat, p));
      if (hideEmpty) where.push('energy_kcal_100g IS NOT NULL');
      let orderBy: string = ORDER.off[sort];
      if (sort === 'relevance') {
        p.push(q + '%');
        orderBy = `(product_name ILIKE $${p.length}) DESC, length(product_name) ASC, product_name ASC`;
      }
      const sql = `
        SELECT code, product_name, brands, categories, nutriscore_grade,
               energy_kcal_100g kcal, proteins_100g protein, sugars_100g sugars, fat_100g fat
          FROM off_product WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ${offCap}`;
      tasks.push(pool.query(sql, p).then((r) => {
        offRows.push(...r.rows.map((x) => ({
          source: 'off', id: x.code, title: x.product_name,
          brand: firstBrand(x.brands), category: lastCategory(x.categories),
          sub: subOf(firstBrand(x.brands), lastCategory(x.categories)),
          grade: x.nutriscore_grade, kcal: x.kcal, protein: x.protein, sugars: x.sugars, fat: x.fat,
          dataType: 'off', variantCount: 1,
        })));
      }));
    }

    await Promise.all(tasks);
    const out = [...groupUsda(usdaRows), ...offRows];

    // Merge-sort across sources for the chosen order.
    const ql = q.toLowerCase();
    if (sort === 'kcal_desc') out.sort((a, b) => (b.kcal ?? -1) - (a.kcal ?? -1));
    else if (sort === 'kcal_asc') out.sort((a, b) => (a.kcal ?? Infinity) - (b.kcal ?? Infinity));
    else if (sort === 'protein_desc') out.sort((a, b) => (b.protein ?? -1) - (a.protein ?? -1));
    else if (sort === 'name') out.sort((a, b) => a.title.localeCompare(b.title));
    else out.sort((a, b) => scoreItem(a, ql) - scoreItem(b, ql)); // relevance

    const all = dedupeByTitleBrand(out);
    const results = all.slice(offset, offset + limit);
    const hasMore = all.length > offset + limit;
    // Attach a GI indicator to whole-food results (cached lookup).
    for (const it of results) {
      if (it.source === 'usda' && it.dataType && it.dataType !== 'branded_food') {
        const g = await matchGi(it.title);
        if (g) { it.gi = g.gi; it.giCategory = g.category; }
      }
    }
    const payload = { results, hasMore };
    cacheSet('s:' + req.originalUrl, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: 'query failed', detail: String(err) });
  }
});

// Glycemic-index lookup (cached). Matched to whole foods by keyword.
let GI_CACHE: { gi: number; category: string; name: string; keywords: string[] }[] | null = null;
async function giValues() {
  if (GI_CACHE) return GI_CACHE;
  try { GI_CACHE = (await pool.query('SELECT gi, category, name, keywords FROM gi_values')).rows; }
  catch { GI_CACHE = []; }
  return GI_CACHE;
}
async function matchGi(desc: string) {
  const d = (desc || '').toLowerCase();
  let best: any = null;
  for (const e of await giValues()) {
    if (e.keywords.every((k: string) => d.includes(k)) && (!best || e.keywords.length > best.keywords.length)) best = e;
  }
  return best;
}

// Human-readable serving label for a branded row. Rounds float noise and maps
// FDC unit codes (GRM->g, MLT->ml).
function servingText(r: any): string {
  const map: Record<string, string> = { grm: 'g', mlt: 'ml' };
  const raw = (r.serving_size_unit || '').trim();
  const u = map[raw.toLowerCase()] || raw;
  const size = r.serving_size != null ? Number(r.serving_size).toLocaleString('en-US', { maximumFractionDigits: 1 }) : null;
  if (r.household_serving) return size ? `${r.household_serving} (${size} ${u})` : r.household_serving;
  if (size) return `${size} ${u}`.trim();
  return 'per 100 g';
}

// Merge near-duplicate USDA rows into one result per (brand + normalized name).
// Normalization is conservative — lowercase, punctuation/space-insensitive —
// so it collapses cosmetic differences without merging distinct products.
// Each group exposes its members as variants (for the serving dropdown).
// Consistent "Brand · Category" subtitle for any result (omits blank parts).
function subOf(brand: string | null, category: string | null): string {
  return [brand, category].map((s) => (s || '').trim()).filter(Boolean).join(' · ');
}
// OFF `categories` is a comma list, broad→specific; take the most specific
// and de-slug it ("milk-chocolate-bar" -> "milk chocolate bar").
function lastCategory(c: string | null): string {
  if (!c) return '';
  const parts = String(c).split(',').map((s) => s.replace(/^[a-z]{2}:/, '').trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1].replace(/-/g, ' ') : '';
}
// First brand only (OFF brands are often comma-duplicated, e.g. "Billa,Billa Premium").
const firstBrand = (b: string | null) => (b ? String(b).split(',')[0].trim() : '');

// Preferred USDA dataset order when the same food appears in several programs.
// Foundation/SR Legacy are lab analyses; Survey (FNDDS) is dietary-survey data;
// branded last. The representative's headline values come from the best source.
const DATASET_RANK: Record<string, number> = {
  foundation_food: 0, sr_legacy_food: 1, survey_fndds_food: 2, branded_food: 3,
};
const datasetRank = (dt: string) => DATASET_RANK[dt] ?? 4;

function groupUsda(rows: any[]): any[] {
  const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Singularize each word so "Banana, raw" and "Bananas, raw" (different USDA
  // datasets) collapse into one food. Guards short words and "ss" endings.
  const singular = (s: string) => s.split(' ')
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) ? w.slice(0, -1) : w)
    .join(' ');

  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const key = norm(r.brand) + '|' + singular(norm(r.description));
    const grp = groups.get(key);
    if (grp) grp.push(r); else groups.set(key, [r]);
  }

  return [...groups.values()].map((grp) => {
    grp.sort((a, b) => datasetRank(a.data_type) - datasetRank(b.data_type)); // best dataset first
    const rep = grp[0];
    const category = rep.food_category || rep.branded_food_category || '';
    // One variant per distinct serving (whole foods all share "per 100 g", so
    // cross-dataset dupes collapse rather than spamming the dropdown).
    const variants: { id: string; serving: string }[] = [];
    const seen = new Set<string>();
    for (const r of grp) {
      const serving = servingText(r);
      if (seen.has(serving)) continue;
      seen.add(serving);
      variants.push({ id: String(r.fdc_id), serving });
    }
    return {
      source: 'usda', id: String(rep.fdc_id), title: rep.description, brand: rep.brand || '',
      category, sub: subOf(rep.brand, category), dataType: rep.data_type,
      kcal: rep.kcal, protein: rep.protein, sugars: rep.sugars, fat: rep.fat,
      variants, variantCount: variants.length,
    };
  });
}

// Lower score = better. Blends match quality (exact > prefix > word-start >
// substring), a whole/foundation-food boost, and a shorter-name preference so
// canonical foods ("Bananas, raw", "Cheerios Cereal") beat long branded names.
// Source/type tier — USDA analytical raw foods rank above survey dishes and
// branded/OFF packaged products, so staples beat prepared/branded items.
const TIER: Record<string, number> = {
  foundation_food: 2800,
  sr_legacy_food: 2800, // same tier as foundation; comma + shortest name picks the generic
  survey_fndds_food: 1800,
};

function scoreItem(item: any, ql: string): number {
  const t = (item.title || '').toLowerCase();
  const e = ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let s = -(TIER[item.dataType] ?? 0);
  // Match quality. USDA names staples in the plural ("Apples, raw"), so allow
  // an optional plural suffix. "Food, modifier" (comma) is the canonical staple
  // naming and beats "Apple juice" / "Banana split".
  const pl = `${e}(?:es|s)?`;
  if (t === ql) s -= 1500;
  else if (new RegExp(`^${pl}\\s*,`).test(t)) s -= 1100; // "Apples, raw"
  else if (new RegExp(`^${pl}\\b`).test(t)) s -= 800; // "Apple juice"
  else if (t.startsWith(ql)) s -= 500; // prefix
  else if (new RegExp(`\\b${e}`).test(t)) s -= 250; // word-boundary elsewhere
  s += Math.min(t.length, 120); // shorter, more generic names rank higher
  return s;
}

// Collapse identical name+brand entries (common OFF noise: many "banana" rows).
function dedupeByTitleBrand(items: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const it of items) {
    const key = `${(it.title || '').toLowerCase().trim()}|${(it.brand || '').toLowerCase().trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// FDC nutrient name -> normalized label field. Units already match the label
// (G / MG / UG=mcg) so amounts pass through unscaled by unit.
const FDC_NUTRIENTS: Record<string, { names: string[]; unit?: string }> = {
  energyKcal: { names: ['Energy'], unit: 'KCAL' },
  fat: { names: ['Total lipid (fat)'] },
  satFat: { names: ['Fatty acids, total saturated'] },
  transFat: { names: ['Fatty acids, total trans'] },
  cholesterol: { names: ['Cholesterol'] },
  sodium: { names: ['Sodium, Na'] },
  carbs: { names: ['Carbohydrate, by difference'] },
  fiber: { names: ['Fiber, total dietary'] },
  sugars: { names: ['Sugars, total including NLEA', 'Total Sugars', 'Sugars, Total'] },
  addedSugars: { names: ['Sugars, added', 'Added Sugars'] },
  protein: { names: ['Protein'] },
  vitaminD: { names: ['Vitamin D (D2 + D3)'] },
  calcium: { names: ['Calcium, Ca'] },
  iron: { names: ['Iron, Fe'] },
  potassium: { names: ['Potassium, K'] },
  vitaminC: { names: ['Vitamin C, total ascorbic acid'] },
};

// Extended nutrient detail (USDA whole foods carry ~100 nutrients). Grouped for
// a collapsed "Full nutrient detail" expander; each item maps a display name to
// the USDA nutrient name(s). Only items/sections with data are returned.
const FDC_DETAIL: { title: string; items: { label: string; names: string[] }[] }[] = [
  { title: 'Vitamins', items: [
    { label: 'Vitamin A (RAE)', names: ['Vitamin A, RAE'] },
    { label: 'Vitamin E', names: ['Vitamin E (alpha-tocopherol)'] },
    { label: 'Vitamin K', names: ['Vitamin K (phylloquinone)'] },
    { label: 'Thiamin (B1)', names: ['Thiamin'] },
    { label: 'Riboflavin (B2)', names: ['Riboflavin'] },
    { label: 'Niacin (B3)', names: ['Niacin'] },
    { label: 'Pantothenic acid (B5)', names: ['Pantothenic acid'] },
    { label: 'Vitamin B6', names: ['Vitamin B-6'] },
    { label: 'Folate (B9, DFE)', names: ['Folate, DFE', 'Folate, total'] },
    { label: 'Vitamin B12', names: ['Vitamin B-12'] },
    { label: 'Choline', names: ['Choline, total'] },
  ] },
  { title: 'Minerals', items: [
    { label: 'Magnesium', names: ['Magnesium, Mg'] },
    { label: 'Phosphorus', names: ['Phosphorus, P'] },
    { label: 'Zinc', names: ['Zinc, Zn'] },
    { label: 'Copper', names: ['Copper, Cu'] },
    { label: 'Manganese', names: ['Manganese, Mn'] },
    { label: 'Selenium', names: ['Selenium, Se'] },
  ] },
  { title: 'Fat detail', items: [
    { label: 'Monounsaturated', names: ['Fatty acids, total monounsaturated'] },
    { label: 'Polyunsaturated', names: ['Fatty acids, total polyunsaturated'] },
    { label: 'Omega-3 (ALA 18:3)', names: ['PUFA 18:3'] },
    { label: 'Omega-6 (LA 18:2)', names: ['PUFA 18:2'] },
  ] },
  { title: 'Carbohydrate detail', items: [
    { label: 'Starch', names: ['Starch'] },
    { label: 'Glucose', names: ['Glucose'] },
    { label: 'Fructose', names: ['Fructose'] },
    { label: 'Sucrose', names: ['Sucrose'] },
    { label: 'Lactose', names: ['Lactose'] },
    { label: 'Maltose', names: ['Maltose'] },
  ] },
  { title: 'Amino acids', items: [
    { label: 'Tryptophan', names: ['Tryptophan'] }, { label: 'Threonine', names: ['Threonine'] },
    { label: 'Isoleucine', names: ['Isoleucine'] }, { label: 'Leucine', names: ['Leucine'] },
    { label: 'Lysine', names: ['Lysine'] }, { label: 'Methionine', names: ['Methionine'] },
    { label: 'Cystine', names: ['Cystine'] }, { label: 'Phenylalanine', names: ['Phenylalanine'] },
    { label: 'Tyrosine', names: ['Tyrosine'] }, { label: 'Valine', names: ['Valine'] },
    { label: 'Arginine', names: ['Arginine'] }, { label: 'Histidine', names: ['Histidine'] },
    { label: 'Alanine', names: ['Alanine'] }, { label: 'Aspartic acid', names: ['Aspartic acid'] },
    { label: 'Glutamic acid', names: ['Glutamic acid'] }, { label: 'Glycine', names: ['Glycine'] },
    { label: 'Proline', names: ['Proline'] }, { label: 'Serine', names: ['Serine'] },
  ] },
];

// USDA unit codes → display units. Amounts are per 100 g (client scales).
const UNIT_DISPLAY: Record<string, string> = { G: 'g', MG: 'mg', UG: 'µg', IU: 'IU', KCAL: 'kcal' };

function buildDetail(rows: { name: string; unit_name: string; amount: number | null }[]) {
  const byName = new Map<string, { amount: number; unit: string }>();
  for (const r of rows) {
    if (r.amount == null || byName.has(r.name)) continue;
    byName.set(r.name, { amount: Number(r.amount), unit: UNIT_DISPLAY[r.unit_name] || (r.unit_name || '').toLowerCase() });
  }
  const out: { title: string; items: { label: string; amount: number; unit: string }[] }[] = [];
  for (const sec of FDC_DETAIL) {
    const items: { label: string; amount: number; unit: string }[] = [];
    for (const it of sec.items) {
      const hit = it.names.map((nm) => byName.get(nm)).find(Boolean);
      if (hit) items.push({ label: it.label, amount: +hit.amount.toFixed(4), unit: hit.unit });
    }
    if (items.length) out.push({ title: sec.title, items });
  }
  return out;
}

async function fdcLabel(id: number) {
  const food = await pool.query(
    `SELECT f.fdc_id, f.description, f.data_type, f.food_category,
            b.brand_owner, b.brand_name, b.serving_size, b.serving_size_unit,
            b.household_serving, b.ingredients
       FROM fdc_food f
       LEFT JOIN fdc_branded b ON b.fdc_id = f.fdc_id
      WHERE f.fdc_id = $1`,
    [id],
  );
  if (food.rowCount === 0) return null;
  const f = food.rows[0];

  const nut = await pool.query(
    `SELECT n.name, n.unit_name, fn.amount
       FROM fdc_food_nutrient fn JOIN fdc_nutrient n ON n.id = fn.nutrient_id
      WHERE fn.fdc_id = $1`,
    [id],
  );

  const find = (spec: { names: string[]; unit?: string }) => {
    const row = nut.rows.find(
      (r) => spec.names.includes(r.name) && (!spec.unit || r.unit_name === spec.unit),
    );
    return row?.amount != null ? Number(row.amount) : null;
  };

  // Values are per 100 g; the client scales them to the chosen serving.
  const n: Record<string, number | null> = {};
  for (const [field, spec] of Object.entries(FDC_NUTRIENTS)) {
    const v = find(spec);
    n[field] = v == null ? null : +v.toFixed(3);
  }

  const unit = (f.serving_size_unit || '').toLowerCase();
  const servingGrams =
    f.serving_size && ['g', 'ml', 'grm', 'mlt'].includes(unit) ? Number(f.serving_size) : null;

  // Glycemic index applies to whole/generic foods, not arbitrary branded items.
  const g = f.data_type !== 'branded_food' ? await matchGi(f.description) : null;

  return {
    source: 'usda',
    id: String(f.fdc_id),
    title: f.description,
    brand: f.brand_name || f.brand_owner || '',
    category: f.food_category || f.data_type?.replace(/_/g, ' ') || '',
    servings: buildServings(servingGrams, f.household_serving),
    ingredients: f.ingredients || '',
    n,
    detail: buildDetail(nut.rows),
    nova: null,
    grade: null,
    allergens: [],
    diet: [],
    gi: g ? g.gi : null,
    giCategory: g ? g.category : null,
    giSource: g ? g.name : null,
  };
}

const OZ_G = 28.3495;
const round1 = (x: number) => Math.round(x * 10) / 10;

// Build the serving-size options the label calculator offers. The product's
// own serving (when its grams are known) is first and becomes the default.
function buildServings(servingGrams: number | null, household: string | null): { label: string; grams: number }[] {
  const out: { label: string; grams: number }[] = [];
  if (servingGrams && servingGrams > 0) {
    out.push({ label: household ? `${household} (${round1(servingGrams)} g)` : `1 serving (${round1(servingGrams)} g)`, grams: servingGrams });
  }
  out.push({ label: '100 g', grams: 100 });
  out.push({ label: '1 oz (28.3 g)', grams: OZ_G });
  return out;
}

async function offLabel(code: string) {
  const r = await pool.query(`SELECT * FROM off_product WHERE code = $1`, [code]);
  if (r.rowCount === 0) return null;
  const p = r.rows[0];
  const num = (v: unknown) => (v == null ? null : Number(v));
  // OFF micronutrients are stored as grams/100g, with occasional garbage
  // (negatives, absurd maxima). Sanitize, then convert to label units.
  const gToMg = (v: unknown) => {
    const n = v == null ? null : Number(v);
    return n == null || n < 0 || n > 100 ? null : +(n * 1000).toFixed(2);
  };
  const gToMcg = (v: unknown) => {
    const n = v == null ? null : Number(v);
    return n == null || n < 0 || n > 100 ? null : +(n * 1_000_000).toFixed(1);
  };

  // Parse grams from the free-text serving_size (e.g. "30 g", "1 cup (240 ml)").
  const servings: { label: string; grams: number }[] = [];
  const m = p.serving_size ? String(p.serving_size).match(/([\d.]+)\s*(g|ml|gram|grams)\b/i) : null;
  if (m) servings.push({ label: String(p.serving_size).trim(), grams: Number(m[1]) });
  servings.push({ label: '100 g', grams: 100 });
  servings.push({ label: '1 oz (28.3 g)', grams: OZ_G });

  return {
    source: 'off',
    id: p.code,
    title: p.product_name || '(unnamed product)',
    brand: p.brands || '',
    category: p.categories ? String(p.categories).split(',')[0] : '',
    servings,
    ingredients: p.ingredients_text || '',
    n: {
      energyKcal: num(p.energy_kcal_100g),
      fat: num(p.fat_100g),
      satFat: num(p.saturated_fat_100g),
      transFat: null,
      cholesterol: null,
      sodium: p.sodium_100g == null ? null : +(Number(p.sodium_100g) * 1000).toFixed(1), // g -> mg
      carbs: num(p.carbohydrates_100g),
      fiber: num(p.fiber_100g),
      sugars: num(p.sugars_100g),
      addedSugars: null,
      protein: num(p.proteins_100g),
      vitaminD: gToMcg(p.vitamin_d_100g),
      calcium: gToMg(p.calcium_100g),
      iron: gToMg(p.iron_100g),
      potassium: gToMg(p.potassium_100g),
      vitaminC: gToMg(p.vitamin_c_100g),
    },
    detail: [],
    nova: p.nova_group == null ? null : Number(p.nova_group),
    grade: /^[a-e]$/.test(p.nutriscore_grade || '') ? p.nutriscore_grade : null,
    allergens: parseAllergens(p.allergens),
    diet: parseDiet(p.diet_tags),
    gi: null, giCategory: null, giSource: null,
  };
}

// Parse OFF tag strings ("en:milk,en:soybeans") into display labels.
function parseAllergens(s: string | null): string[] {
  if (!s) return [];
  const seen = new Set<string>();
  for (const t of s.split(',')) {
    const v = t.replace(/^[a-z]{2}:/, '').replace(/-/g, ' ').trim();
    if (v) seen.add(v);
  }
  return [...seen].slice(0, 12);
}
const DIET_FLAGS: Record<string, string> = {
  vegan: 'Vegan', vegetarian: 'Vegetarian', 'gluten-free': 'Gluten-free',
  'no-gluten': 'Gluten-free', organic: 'Organic', 'palm-oil-free': 'Palm-oil-free',
};
function parseDiet(s: string | null): string[] {
  if (!s) return [];
  const out = new Set<string>();
  for (const t of s.split(',')) {
    const v = DIET_FLAGS[t.replace(/^[a-z]{2}:/, '').trim().toLowerCase()];
    if (v) out.add(v);
  }
  return [...out];
}

app.get('/api/food', async (req, res) => {
  const source = String(req.query.source ?? '');
  const id = String(req.query.id ?? '');
  if (!id) return void res.status(400).json({ error: 'id required' });
  try {
    const label =
      source === 'usda' ? await fdcLabel(Number(id)) : source === 'off' ? await offLabel(id) : null;
    if (!label) return void res.status(404).json({ error: 'not found' });
    res.json(label);
  } catch (err) {
    res.status(500).json({ error: 'lookup failed', detail: String(err) });
  }
});

// ── Recipes ────────────────────────────────────────────────────────────────
const RECIPE_SORT: Record<string, string> = {
  relevance: '',
  rating: 'rating DESC NULLS LAST, review_count DESC NULLS LAST',
  quick: 'minutes ASC NULLS LAST',
  calories_asc: 'calories ASC NULLS LAST',
  calories_desc: 'calories DESC NULLS LAST',
};

// Top recipe categories (Food.com only) for the browse dropdown. Cached ~6h.
let CATEGORY_CACHE: { t: number; data: string[] } | null = null;
app.get('/api/recipe-categories', async (_req, res) => {
  if (CATEGORY_CACHE && Date.now() - CATEGORY_CACHE.t < 6 * 60 * 60 * 1000) {
    return void res.json({ categories: CATEGORY_CACHE.data });
  }
  try {
    const r = await pool.query(
      `SELECT category FROM recipe WHERE category IS NOT NULL AND category <> ''
        GROUP BY category ORDER BY count(*) DESC LIMIT 60`);
    const data = r.rows.map((x) => x.category);
    CATEGORY_CACHE = { t: Date.now(), data };
    res.json({ categories: data });
  } catch {
    res.json({ categories: [] });
  }
});

app.get('/api/recipes', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const category = String(req.query.category ?? '').trim();
  // Need either a search term or a category to browse (categories are Food.com).
  if (q.length < 3 && !category) return void res.json({ results: [], hasMore: false });
  const cached = cacheGet('r:' + req.originalUrl);
  if (cached) return void res.json(cached);
  const source = String(req.query.source ?? 'all');
  const sort = String(req.query.sort ?? 'relevance');
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 40));
  const offset = Math.min(2000, Math.max(0, Number(req.query.offset) || 0));
  try {
    const p: unknown[] = [];
    const where: string[] = [];
    if (q.length >= 3) { p.push(`%${q}%`); where.push(`title ILIKE $${p.length}`); }
    if (category) { p.push(category); where.push(`category = $${p.length}`); }
    if (source === 'foodcom' || source === 'recipenlg') { p.push(source); where.push(`source = $${p.length}`); }

    let orderBy = RECIPE_SORT[sort] || '';
    if (!orderBy) {
      if (q.length >= 3) { // relevance: prefix match, then shorter (generic) titles,
        // rating only as a tiebreaker so both sources interleave.
        p.push(`${q}%`);
        orderBy = `(title ILIKE $${p.length}) DESC, length(title) ASC, rating DESC NULLS LAST, title ASC`;
      } else { // category browse with no query: best-rated first
        orderBy = `rating DESC NULLS LAST, review_count DESC NULLS LAST, title ASC`;
      }
    }
    p.push(limit + 1, offset); // fetch one extra to detect "has more"
    // DISTINCT ON (lower(title)) collapses RecipeNLG's many identical titles to
    // one row (best-rated representative) BEFORE the limit, so a page isn't all
    // dupes. The outer query applies the chosen ordering + pagination.
    const r = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (lower(title))
                id, source, title, minutes, n_ingredients, rating, review_count, calories, image, source_url
           FROM recipe WHERE ${where.join(' AND ')}
           ORDER BY lower(title), rating DESC NULLS LAST
       ) s ORDER BY ${orderBy} LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
    const hasMore = r.rows.length > limit;
    const payload = { results: r.rows.slice(0, limit), hasMore };
    cacheSet('r:' + req.originalUrl, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: 'query failed', detail: String(err) });
  }
});

app.get('/api/recipe', async (req, res) => {
  const id = Number(req.query.id);
  if (!Number.isFinite(id)) return void res.status(400).json({ error: 'id required' });
  try {
    const r = await pool.query(
      `SELECT id, source, source_id, title, ingredients, steps, tags, minutes, n_ingredients,
              source_url, image, category, description, rating, review_count,
              calories, fat_g, sat_fat_g, cholesterol_mg, sugar_g, fiber_g, sodium_mg, protein_g, carbs_g
         FROM recipe WHERE id = $1`, [id]);
    if (!r.rowCount) return void res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'lookup failed', detail: String(err) });
  }
});

// ── Server-rendered food pages (permalinks + SEO) ──────────────────────────
const MACRO_ROWS: [string, string, string][] = [
  ['Calories', 'energyKcal', 'kcal'], ['Total Fat', 'fat', 'g'], ['Saturated Fat', 'satFat', 'g'],
  ['Sodium', 'sodium', 'mg'], ['Total Carbohydrate', 'carbs', 'g'], ['Dietary Fiber', 'fiber', 'g'],
  ['Total Sugars', 'sugars', 'g'], ['Protein', 'protein', 'g'],
];

// A real (crawlable) per-100g summary; the client hydrates the full interactive
// label over it on load.
function labelSummaryHtml(d: any): string {
  const rows = MACRO_ROWS.filter(([, k]) => d.n[k] != null)
    .map(([label, k, u]) => `<tr><td>${label}</td><td class="dv">${k === 'energyKcal' ? Math.round(d.n[k]) : (+d.n[k]).toFixed(1)} ${u}</td></tr>`)
    .join('');
  return `<div class="nf">
    ${d.brand ? `<p class="brand">${escHtml(d.brand)}</p>` : ''}
    <h1 class="name">${escHtml(d.title)}</h1>
    <p class="title">Nutrition Facts</p>
    <p class="serving">Per 100 g</p>
    <table>${rows}</table>
    ${d.allergens?.length ? `<p class="nf-allergens"><b>Allergens:</b> ${d.allergens.map(escHtml).join(', ')}</p>` : ''}
    ${d.ingredients ? `<p class="ingredients"><b>Ingredients:</b> ${escHtml(d.ingredients)}</p>` : ''}
  </div>`;
}

function renderFoodPage(d: any): string {
  const n = d.n;
  const macro = (k: string, u: string) => (n[k] == null ? '' : `${k === 'energyKcal' ? Math.round(n[k]) : +(+n[k]).toFixed(1)}${u}`);
  const title = `${d.title}${d.brand ? ` (${d.brand})` : ''} — Nutrition Facts | FoodLand.fyi`;
  const desc = `${d.title}: ${macro('energyKcal', ' kcal')}, ${macro('protein', 'g')} protein, ${macro('carbs', 'g')} carbs, ${macro('fat', 'g')} fat per 100 g. Full nutrition facts, %DV, and ingredients.`.replace(/\s+,/g, ',');
  const url = `${ORIGIN}/food/${d.source}/${encodeURIComponent(d.id)}`;
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'Product', name: d.title,
    ...(d.brand ? { brand: { '@type': 'Brand', name: d.brand } } : {}),
    description: desc, url,
    nutrition: {
      '@type': 'NutritionInformation', servingSize: '100 g',
      ...(n.energyKcal != null ? { calories: `${Math.round(n.energyKcal)} kcal` } : {}),
      ...(n.protein != null ? { proteinContent: `${(+n.protein).toFixed(1)} g` } : {}),
      ...(n.carbs != null ? { carbohydrateContent: `${(+n.carbs).toFixed(1)} g` } : {}),
      ...(n.fat != null ? { fatContent: `${(+n.fat).toFixed(1)} g` } : {}),
    },
  };
  const head = `
    <meta name="description" content="${escHtml(desc)}" />
    <link rel="canonical" href="${escHtml(url)}" />
    <meta property="og:title" content="${escHtml(title)}" />
    <meta property="og:description" content="${escHtml(desc)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${escHtml(url)}" />
    <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
  `;
  const dataScript = `<script>window.__FOOD__=${JSON.stringify(d).replace(/</g, '\\u003c')};</script>`;

  return SHELL
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escHtml(title)}</title>`)
    .replace('</head>', `${head}</head>`)
    .replace('id="label-panel" class="label-panel" hidden', 'id="label-panel" class="label-panel"')
    .replace('<div id="label"></div>', `<div id="label"><div id="label-body">${labelSummaryHtml(d)}</div></div>`)
    .replace('<script src="/app.js">', `${dataScript}<script src="/app.js">`);
}

app.get('/food/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  let label: any = null;
  try {
    label = source === 'usda' ? await fdcLabel(Number(id)) : source === 'off' ? await offLabel(id) : null;
  } catch { /* fall through to 404 */ }
  if (!label) return void res.status(404).type('html').send(stamp(SHELL));
  res.type('html').send(stamp(renderFoodPage(label)));
});

// ── Server-rendered recipe pages (permalinks + SEO) ────────────────────────
// RecipeNLG stripped "/" from fractions; restore known cooking fractions (see
// the client's fixFractions for the rationale).
const FRAC: Record<string, string> = { 12: '1/2', 13: '1/3', 23: '2/3', 14: '1/4', 34: '3/4', 18: '1/8', 38: '3/8', 58: '5/8', 78: '7/8', 25: '2/5', 35: '3/5', 45: '4/5' };
const FRAC_CODES = Object.keys(FRAC).join('|');
function fixFractions(s: string): string {
  if (!s) return s;
  return String(s)
    .replace(new RegExp(`(\\d)\\s+(${FRAC_CODES})(?=\\s|$)`, 'g'), (_m, d, c) => `${d} ${FRAC[c]}`)
    .replace(new RegExp(`(^|\\s)(${FRAC_CODES})\\s+(cups?|teaspoons?|tablespoons?|tsp|tbsp)\\b`, 'gi'), (_m, pre, c, u) => `${pre}${FRAC[c]} ${u}`);
}

function recipeSummaryHtml(d: any): string {
  const ing = (d.ingredients || []).map((x: string) => `<li>${escHtml(fixFractions(x))}</li>`).join('');
  const steps = (d.steps || []).map((x: string) => `<li>${escHtml(fixFractions(x))}</li>`).join('');
  return `
    ${d.image ? `<img class="r-img" src="${escHtml(d.image)}" alt="${escHtml(d.title)}" />` : ''}
    <h1 class="r-title">${escHtml(d.title)}</h1>
    ${d.category ? `<p class="r-cat">${escHtml(d.category)}</p>` : ''}
    <div class="r-cols">
      <div class="r-ing"><h3>Ingredients</h3><ul>${ing}</ul></div>
      <div class="r-steps"><h3>Directions</h3><ol>${steps}</ol></div>
    </div>`;
}

function renderRecipePage(d: any): string {
  const url = `${ORIGIN}/recipe/${d.id}`;
  const srcName = d.source === 'foodcom' ? 'Food.com' : 'RecipeNLG';
  const title = `${d.title} — Recipe | FoodLand.fyi`;
  const desc = (d.description
    || `${d.title} recipe${d.minutes ? ` — ready in ${d.minutes} min` : ''}. Ingredients, directions${d.calories != null ? `, and ${Math.round(d.calories)} calories per serving` : ''}. From ${srcName}.`)
    .replace(/\s+/g, ' ').slice(0, 300);
  const jsonLd: any = {
    '@context': 'https://schema.org', '@type': 'Recipe', name: d.title, url,
    ...(d.image ? { image: [d.image] } : {}),
    ...(d.description ? { description: d.description } : {}),
    recipeIngredient: (d.ingredients || []).map(fixFractions),
    recipeInstructions: (d.steps || []).map((s: string) => ({ '@type': 'HowToStep', text: fixFractions(s) })),
    ...(d.minutes ? { totalTime: `PT${d.minutes}M` } : {}),
    ...(d.category ? { recipeCategory: d.category } : {}),
    ...(d.rating != null ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: d.rating, reviewCount: d.review_count || 1 } } : {}),
    ...(d.calories != null ? {
      nutrition: {
        '@type': 'NutritionInformation', calories: `${Math.round(d.calories)} calories`,
        ...(d.fat_g != null ? { fatContent: `${d.fat_g} g` } : {}),
        ...(d.carbs_g != null ? { carbohydrateContent: `${d.carbs_g} g` } : {}),
        ...(d.protein_g != null ? { proteinContent: `${d.protein_g} g` } : {}),
      },
    } : {}),
  };
  const head = `
    <meta name="description" content="${escHtml(desc)}" />
    <link rel="canonical" href="${escHtml(url)}" />
    <meta property="og:title" content="${escHtml(title)}" />
    <meta property="og:description" content="${escHtml(desc)}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${escHtml(url)}" />
    ${d.image ? `<meta property="og:image" content="${escHtml(d.image)}" />` : ''}
    <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
  `;
  const dataScript = `<script>window.__RECIPE__=${JSON.stringify(d).replace(/</g, '\\u003c')};</script>`;

  return SHELL
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escHtml(title)}</title>`)
    .replace('</head>', `${head}</head>`)
    .replace('<div class="page" id="page-food">', '<div class="page" id="page-food" hidden>')
    .replace('<div class="page" id="page-recipe" hidden>', '<div class="page" id="page-recipe">')
    .replace('id="recipe-panel" class="recipe-panel" hidden', 'id="recipe-panel" class="recipe-panel"')
    .replace('<div id="recipe"></div>', `<div id="recipe">${recipeSummaryHtml(d)}</div>`)
    .replace('<script src="/app.js">', `${dataScript}<script src="/app.js">`);
}

app.get('/recipe/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return void res.status(404).type('html').send(stamp(SHELL));
  try {
    const r = await pool.query(
      `SELECT id, source, source_id, title, ingredients, steps, tags, minutes, n_ingredients,
              source_url, image, category, description, rating, review_count,
              calories, fat_g, sat_fat_g, cholesterol_mg, sugar_g, fiber_g, sodium_mg, protein_g, carbs_g
         FROM recipe WHERE id = $1`, [id]);
    if (!r.rowCount) return void res.status(404).type('html').send(stamp(SHELL));
    res.type('html').send(stamp(renderRecipePage(r.rows[0])));
  } catch {
    res.status(404).type('html').send(stamp(SHELL));
  }
});

// ── robots.txt + sitemaps ──────────────────────────────────────────────────
const SITEMAP_PAGE = 25000;

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`);
});

app.get('/sitemap.xml', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM fdc_food)    AS usda,
              (SELECT count(*) FROM off_product) AS off,
              (SELECT count(*) FROM recipe)      AS recipe`,
    );
    const pages: string[] = [];
    const add = (src: string, total: number) => {
      for (let i = 0; i < Math.ceil(Number(total) / SITEMAP_PAGE); i++) pages.push(`${ORIGIN}/sitemaps/${src}/${i}.xml`);
    };
    add('usda', rows[0].usda);
    add('off', rows[0].off);
    add('recipe', rows[0].recipe);
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      pages.map((p) => `<sitemap><loc>${p}</loc></sitemap>`).join('\n') +
      `\n</sitemapindex>`,
    );
  } catch {
    res.status(503).type('text/plain').send('sitemap unavailable');
  }
});

app.get('/sitemaps/:source/:page.xml', async (req, res) => {
  const source = req.params.source;
  const page = Math.max(0, parseInt(req.params.page, 10) || 0);
  if (!['usda', 'off', 'recipe'].includes(source)) return void res.status(404).end();
  try {
    const off = [SITEMAP_PAGE, page * SITEMAP_PAGE];
    let loc: (id: string) => string;
    let rows: { id: string }[];
    if (source === 'usda') {
      rows = (await pool.query(`SELECT fdc_id::text id FROM fdc_food ORDER BY fdc_id LIMIT $1 OFFSET $2`, off)).rows;
      loc = (id) => `${ORIGIN}/food/usda/${encodeURIComponent(id)}`;
    } else if (source === 'off') {
      rows = (await pool.query(`SELECT code id FROM off_product ORDER BY code LIMIT $1 OFFSET $2`, off)).rows;
      loc = (id) => `${ORIGIN}/food/off/${encodeURIComponent(id)}`;
    } else {
      rows = (await pool.query(`SELECT id::text id FROM recipe ORDER BY id LIMIT $1 OFFSET $2`, off)).rows;
      loc = (id) => `${ORIGIN}/recipe/${encodeURIComponent(id)}`;
    }
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      rows.map((r) => `<url><loc>${loc(r.id)}</loc></url>`).join('\n') +
      `\n</urlset>`,
    );
  } catch {
    res.status(503).end();
  }
});

// Minimal content-page shell (for non-SPA pages like docs and leaders).
function contentPage(title: string, desc: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escHtml(title)}</title><meta name="description" content="${escHtml(desc)}"/>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"/>
<link rel="canonical" href="${ORIGIN}/"/><link rel="stylesheet" href="/styles.css"/></head>
<body><header><a href="/" class="brand">FoodLand.fyi</a></header>
<main style="display:block;max-width:760px"><div class="page">${body}</div></main>
<footer><p class="meta"><a href="/">Search</a> · <a href="/leaders">Leaders</a> · <a href="/developers">API</a></p></footer>
</body></html>`;
}

// ── Developer API docs ─────────────────────────────────────────────────────
app.get('/developers', (_req, res) => {
  const body = `<h1>FoodLand.fyi API</h1>
    <p class="page-lead">Free read-only JSON API over USDA FoodData Central + Open Food Facts. CORS-enabled, rate-limited to 120 requests/minute per IP. No key required.</p>
    <h2>GET /api/search</h2>
    <p>Params: <code>q</code> (2+ chars or a 6–14 digit barcode), <code>source</code> (all|usda|off), <code>usdatype</code> (all|branded|whole), <code>sort</code> (relevance|name|kcal_desc|kcal_asc|protein_desc), <code>minKcal/maxKcal/minProtein/maxProtein/minSugar/maxSugar/minFat/maxFat</code> (per 100 g).</p>
    <pre>curl "${ORIGIN}/api/search?q=cheddar&amp;source=usda&amp;sort=protein_desc"</pre>
    <h2>GET /api/food</h2>
    <p>Params: <code>source</code> (usda|off), <code>id</code> (USDA fdc_id or OFF barcode). Returns the normalized label (per-100 g nutrients, serving options, ingredients, allergens, diet flags).</p>
    <pre>curl "${ORIGIN}/api/food?source=usda&amp;id=167512"</pre>
    <h2>GET /api/stats</h2>
    <p>Row counts per source.</p>
    <h2>Attribution</h2>
    <p>Data from <a href="https://fdc.nal.usda.gov/">USDA FoodData Central</a> (public domain) and <a href="https://world.openfoodfacts.org/">Open Food Facts</a> (ODbL). Open Food Facts data is licensed under the <a href="https://opendatacommons.org/licenses/odbl/1-0/">Open Database License</a>; reuse must attribute and share alike.</p>`;
  res.type('html').send(contentPage('API — FoodLand.fyi', 'Free JSON nutrition API over 5M+ foods.', body));
});

// ── Leaders (SEO landing pages) ────────────────────────────────────────────
type Leader = { label: string; usdaCol?: string; offCol?: string; unit: string; mul?: number; max: number };
// max is the realistic per-100g ceiling in the column's native unit (grams),
// to filter out data-entry errors that otherwise dominate the rankings.
const LEADERS: Record<string, Leader> = {
  'high-protein': { label: 'Highest-protein foods', usdaCol: 'protein_100g', offCol: 'proteins_100g', unit: 'g', max: 90 },
  'high-fiber': { label: 'Highest-fiber foods', offCol: 'fiber_100g', unit: 'g', max: 80 },
  'high-calcium': { label: 'Highest-calcium foods', offCol: 'calcium_100g', unit: 'mg', mul: 1000, max: 2 },
  'high-iron': { label: 'Highest-iron foods', offCol: 'iron_100g', unit: 'mg', mul: 1000, max: 0.05 },
  'high-potassium': { label: 'Highest-potassium foods', offCol: 'potassium_100g', unit: 'mg', mul: 1000, max: 5 },
  'high-vitamin-c': { label: 'Highest vitamin C foods', offCol: 'vitamin_c_100g', unit: 'mg', mul: 1000, max: 5 },
};

app.get('/leaders', (_req, res) => {
  const links = Object.entries(LEADERS).map(([slug, l]) => `<li><a href="/leaders/${slug}">${escHtml(l.label)}</a></li>`).join('');
  res.type('html').send(contentPage('Nutrient leaders — FoodLand.fyi', 'Foods ranked by nutrient, per 100 g.',
    `<h1>Nutrient leaders</h1><p class="page-lead">Foods ranked by nutrient content per 100 g.</p><ul class="leader-index">${links}</ul>`));
});

app.get('/leaders/:slug', async (req, res) => {
  const l = LEADERS[req.params.slug];
  if (!l) return void res.status(404).type('html').send(contentPage('Not found', '', '<h1>Not found</h1><p><a href="/leaders">All leaders</a></p>'));
  try {
    const parts: any[] = [];
    if (l.usdaCol) parts.push(pool.query(
      `SELECT 'usda' src, fdc_id::text id, description title, ${l.usdaCol} v FROM fdc_food
        WHERE ${l.usdaCol} > 0 AND ${l.usdaCol} <= $1 AND data_type <> 'branded_food'
        ORDER BY ${l.usdaCol} DESC LIMIT 60`, [l.max]));
    if (l.offCol) parts.push(pool.query(
      `SELECT 'off' src, code id, product_name title, ${l.offCol} v FROM off_product
        WHERE ${l.offCol} > 0 AND ${l.offCol} <= $1 AND product_name IS NOT NULL ORDER BY ${l.offCol} DESC LIMIT 60`, [l.max]));
    const rows = (await Promise.all(parts)).flatMap((r) => r.rows);
    const seen = new Set<string>();
    const items = rows
      .map((r) => ({ ...r, val: Number(r.v) * (l.mul ?? 1) }))
      .sort((a, b) => b.val - a.val)
      .filter((r) => { const k = (r.title || '').toLowerCase(); if (!r.title || seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 50);
    const list = items.map((r, i) =>
      `<li><span class="rank">${i + 1}</span><a href="/food/${r.src}/${encodeURIComponent(r.id)}">${escHtml(r.title)}</a>
       <span class="lv">${r.val.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${l.unit}/100 g</span></li>`).join('');
    res.type('html').send(contentPage(`${l.label} | FoodLand.fyi`, `${l.label} ranked per 100 g.`,
      `<h1>${escHtml(l.label)}</h1><p class="page-lead">Top foods by ${escHtml(l.unit)} per 100 g. <a href="/leaders">All leaders</a></p><ol class="leaders">${list}</ol>`));
  } catch {
    res.status(503).type('html').send(contentPage('Unavailable', '', '<h1>Temporarily unavailable</h1>'));
  }
});

app.listen(PORT, () => console.log(`food server listening on :${PORT}`));
