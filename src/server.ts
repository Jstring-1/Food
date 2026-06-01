import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { pool } from './db.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

app.use(express.static(PUBLIC_DIR));

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

app.get('/api/search', async (req, res) => {
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
      return void res.json({ results: bc, mode: 'barcode' });
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
      const sql = `
        SELECT f.fdc_id, f.description, f.data_type, f.food_category,
               f.energy_kcal_100g kcal, f.protein_100g protein, f.sugars_100g sugars, f.fat_100g fat,
               coalesce(b.brand_name, b.brand_owner) AS brand,
               b.serving_size, b.serving_size_unit, b.household_serving FROM fdc_food f
        LEFT JOIN fdc_branded b ON b.fdc_id = f.fdc_id
        WHERE ${where.join(' AND ')} ORDER BY ${ORDER.usda[sort]} LIMIT 80`;
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
      const sql = `
        SELECT code, product_name, brands, nutriscore_grade,
               energy_kcal_100g kcal, proteins_100g protein, sugars_100g sugars, fat_100g fat
          FROM off_product WHERE ${where.join(' AND ')} ORDER BY ${ORDER.off[sort]} LIMIT 40`;
      tasks.push(pool.query(sql, p).then((r) => {
        offRows.push(...r.rows.map((x) => ({ source: 'off', id: x.code, title: x.product_name, sub: x.brands || '', grade: x.nutriscore_grade, kcal: x.kcal, protein: x.protein, sugars: x.sugars, fat: x.fat, variantCount: 1 })));
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
    else out.sort((a, b) => relevance(a.title, ql) - relevance(b.title, ql)); // relevance

    res.json({ results: out.slice(0, 40) });
  } catch (err) {
    res.status(500).json({ error: 'query failed', detail: String(err) });
  }
});

// Human-readable serving label for a branded row.
function servingText(r: any): string {
  const u = (r.serving_size_unit || '').trim();
  if (r.household_serving) return r.serving_size ? `${r.household_serving} (${r.serving_size} ${u})` : r.household_serving;
  if (r.serving_size) return `${r.serving_size} ${u}`.trim();
  return 'per 100 g';
}

// Merge near-duplicate USDA rows into one result per (brand + normalized name).
// Normalization is conservative — lowercase, punctuation/space-insensitive —
// so it collapses cosmetic differences without merging distinct products.
// Each group exposes its members as variants (for the serving dropdown).
function groupUsda(rows: any[]): any[] {
  const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const map = new Map<string, any>();
  for (const r of rows) {
    const key = norm(r.brand) + '|' + norm(r.description);
    let g = map.get(key);
    if (!g) {
      g = {
        source: 'usda', id: String(r.fdc_id), title: r.description,
        sub: r.food_category || r.data_type?.replace(/_/g, ' '),
        kcal: r.kcal, protein: r.protein, sugars: r.sugars, fat: r.fat, variants: [] as any[],
      };
      map.set(key, g);
    }
    g.variants.push({ id: String(r.fdc_id), serving: servingText(r) });
  }
  return [...map.values()].map((g) => ({ ...g, variantCount: g.variants.length }));
}

// Lower score = better: exact, then prefix, then word-boundary, then substring.
function relevance(title: string, ql: string): number {
  const t = (title || '').toLowerCase();
  if (t === ql) return 0;
  if (t.startsWith(ql)) return 1;
  if (new RegExp(`\\b${ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) return 2;
  return 3;
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
};

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

  // Scale to serving when the branded serving is a mass/volume (per-100g basis).
  let factor = 1;
  let servingText = 'per 100 g';
  const unit = (f.serving_size_unit || '').toLowerCase();
  if (f.serving_size && ['g', 'ml', 'grm', 'mlt'].includes(unit)) {
    factor = Number(f.serving_size) / 100;
    servingText = f.household_serving
      ? `${f.household_serving} (${f.serving_size} ${unit})`
      : `${f.serving_size} ${unit}`;
  }

  const n: Record<string, number | null> = {};
  for (const [field, spec] of Object.entries(FDC_NUTRIENTS)) {
    const v = find(spec);
    n[field] = v == null ? null : +(v * factor).toFixed(2);
  }

  return {
    source: 'usda',
    id: String(f.fdc_id),
    title: f.description,
    brand: f.brand_name || f.brand_owner || '',
    category: f.food_category || f.data_type?.replace(/_/g, ' ') || '',
    servingText,
    ingredients: f.ingredients || '',
    n,
  };
}

async function offLabel(code: string) {
  const r = await pool.query(`SELECT * FROM off_product WHERE code = $1`, [code]);
  if (r.rowCount === 0) return null;
  const p = r.rows[0];
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    source: 'off',
    id: p.code,
    title: p.product_name || '(unnamed product)',
    brand: p.brands || '',
    category: p.categories ? String(p.categories).split(',')[0] : '',
    servingText: p.serving_size ? `${p.serving_size} — values per 100 g` : 'per 100 g',
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
      vitaminD: null,
      calcium: null,
      iron: null,
      potassium: null,
    },
  };
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

app.listen(PORT, () => console.log(`food server listening on :${PORT}`));
