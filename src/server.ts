import express from 'express';
import { pool } from './db.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Liveness probe — never touches the DB, so deploys go green even before
// the schema is migrated or data is loaded.
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Search both sources by name. Trigram indexes (pg_trgm) back the ILIKE.
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) {
    res.status(400).json({ error: 'query must be at least 2 characters' });
    return;
  }
  const like = `%${q}%`;
  try {
    const [fdc, off] = await Promise.all([
      pool.query(
        `SELECT fdc_id, description, data_type, food_category
           FROM fdc_food WHERE description ILIKE $1 ORDER BY description LIMIT 25`,
        [like],
      ),
      pool.query(
        `SELECT code, product_name, brands, nutriscore_grade
           FROM off_product WHERE product_name ILIKE $1 ORDER BY product_name LIMIT 25`,
        [like],
      ),
    ]);
    res.json({ usda: fdc.rows, openfoodfacts: off.rows });
  } catch (err) {
    res.status(500).json({ error: 'query failed', detail: String(err) });
  }
});

// Minimal landing page: live row counts + a search box.
app.get('/', async (_req, res) => {
  let counts = '';
  try {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*) FROM fdc_food)    AS usda,
         (SELECT count(*) FROM off_product) AS off`,
    );
    counts = `${Number(rows[0].usda).toLocaleString()} USDA foods · ${Number(
      rows[0].off,
    ).toLocaleString()} Open Food Facts products`;
  } catch {
    counts = 'database not migrated yet — run <code>npm run db:migrate</code>';
  }

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Food &amp; Nutrition DB</title>
  <style>
    :root { color-scheme: dark; }
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 720px; margin: 4rem auto;
           padding: 0 1rem; background: #0e0e14; color: #e6e6ef; }
    h1 { margin-bottom: .25rem; }
    .meta { color: #8a8aa0; margin-bottom: 2rem; }
    input { width: 100%; padding: .7rem 1rem; font-size: 1rem; border-radius: 8px;
            border: 1px solid #33334a; background: #16161f; color: inherit; }
    .row { padding: .6rem 0; border-bottom: 1px solid #22222e; }
    .src { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em;
           color: #6e6e8a; }
    .sub { color: #8a8aa0; font-size: .85rem; }
  </style>
</head>
<body>
  <h1>Food &amp; Nutrition DB</h1>
  <p class="meta">${counts}</p>
  <input id="q" type="search" placeholder="Search foods (e.g. cheddar, banana)…" autofocus />
  <div id="results"></div>
  <script>
    const q = document.getElementById('q');
    const out = document.getElementById('results');
    let t;
    q.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(run, 250);
    });
    async function run() {
      const v = q.value.trim();
      if (v.length < 2) { out.innerHTML = ''; return; }
      const r = await fetch('/api/search?q=' + encodeURIComponent(v));
      if (!r.ok) { out.innerHTML = '<p class="sub">…</p>'; return; }
      const d = await r.json();
      const rows = [];
      for (const f of d.usda || [])
        rows.push('<div class="row"><span class="src">usda</span> ' + esc(f.description) +
          '<div class="sub">' + esc(f.food_category || f.data_type || '') + '</div></div>');
      for (const p of d.openfoodfacts || [])
        rows.push('<div class="row"><span class="src">off</span> ' + esc(p.product_name || '(unnamed)') +
          '<div class="sub">' + esc(p.brands || '') + '</div></div>');
      out.innerHTML = rows.join('') || '<p class="sub">No matches.</p>';
    }
    function esc(s) { const e = document.createElement('div'); e.textContent = s; return e.innerHTML; }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`food server listening on :${PORT}`);
});
