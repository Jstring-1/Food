const foodQ = document.getElementById('q-food');
const foodResults = document.getElementById('results-food');
const recipeQ = document.getElementById('q-recipe');
const recipeResults = document.getElementById('results-recipe');
const panelEl = document.getElementById('label-panel');
const labelEl = document.getElementById('label');
const compareBar = document.getElementById('compare-bar');
const compareModal = document.getElementById('compare-modal');
const compareLabels = document.getElementById('compare-labels');
const compareList = []; // {source, id, title}

// Small grade chips (Nutri-Score / NOVA) with hover explainers.
const NOVA_LABEL = ['', 'Unprocessed or minimally processed', 'Processed culinary ingredients',
  'Processed foods', 'Ultra-processed foods'];
const nutriTitle = (g) => `Nutri-Score ${g.toUpperCase()} — overall nutritional quality (A = best, E = worst)`;
const novaTitle = (n) => `NOVA ${n} — ${NOVA_LABEL[n] || ''} (1 = unprocessed … 4 = ultra-processed)`;
const nutriChip = (g) => (g && /^[a-e]$/.test(g))
  ? `<span class="nutri nutri-${g} grade-chip" title="${nutriTitle(g)}">${g.toUpperCase()}</span>` : '';
const novaChip = (n) => n ? `<span class="nova nova-${n} grade-chip" title="${novaTitle(n)}">${n}</span>` : '';

// FDA Daily Values (2,000 kcal) and display units per normalized field.
const DV = { fat: 78, satFat: 20, cholesterol: 300, sodium: 2300, carbs: 275,
  fiber: 28, addedSugars: 50, vitaminD: 20, calcium: 1300, iron: 18, potassium: 4700, vitaminC: 90 };
const UNIT = { fat: 'g', satFat: 'g', transFat: 'g', cholesterol: 'mg', sodium: 'mg',
  carbs: 'g', fiber: 'g', sugars: 'g', addedSugars: 'g', protein: 'g',
  vitaminD: 'mcg', calcium: 'mg', iron: 'mg', potassium: 'mg', vitaminC: 'mg' };

function esc(s) { const e = document.createElement('div'); e.textContent = s ?? ''; return e.innerHTML; }
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Build one combined matcher for all flagged additives (longest terms first).
let ADDITIVE_RE = null, ADDITIVE_MAP = null;
function additiveMatcher() {
  if (ADDITIVE_RE !== null) return;
  ADDITIVE_MAP = new Map();
  const terms = [];
  for (const a of (window.ADDITIVES || [])) for (const t of a.terms) { terms.push(t); ADDITIVE_MAP.set(t.toLowerCase(), a); }
  terms.sort((x, y) => y.length - x.length);
  ADDITIVE_RE = terms.length ? new RegExp('(?<![\\w-])(' + terms.map(escRe).join('|') + ')(?![\\w-])', 'gi') : false;
}

// Escape ingredient text, then wrap flagged additives in a clickable span that
// opens an info popup (blurb + links to scientific study searches).
function highlightAdditives(raw) {
  additiveMatcher();
  let count = 0;
  if (!ADDITIVE_RE) return { html: esc(raw), count };
  const html = esc(raw).replace(ADDITIVE_RE, (m) => {
    const a = ADDITIVE_MAP.get(m.toLowerCase());
    if (!a) return m;
    count++;
    return `<span class="additive-warn ${a.severity}" role="button" tabindex="0" data-term="${esc(m.toLowerCase())}">${m}</span>`;
  });
  return { html, count };
}
function fmt(v, unit) { return v == null ? null : `${(+v).toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit}`; }
function dv(field, v) { return v == null || !DV[field] ? '' : Math.round((v / DV[field]) * 100) + '%'; }


const $ = (id) => document.getElementById(id);
const isBarcode = (s) => /^\d{6,14}$/.test(s);

// Read the filter controls into URLSearchParams for /api/search.
function readFilters(q) {
  const p = new URLSearchParams({ q });
  p.set('source', $('f-source').value);
  p.set('usdatype', $('f-usdatype').value);
  p.set('sort', $('f-sort').value);
  p.set('hideEmpty', '1'); // always hide entries with no nutrition
  const ranges = { minKcal: 'f-minkcal', maxKcal: 'f-maxkcal', minProtein: 'f-minprotein', maxProtein: 'f-maxprotein',
    minSugar: 'f-minsugar', maxSugar: 'f-maxsugar', minFat: 'f-minfat', maxFat: 'f-maxfat' };
  for (const [key, id] of Object.entries(ranges)) if ($(id).value !== '') p.set(key, $(id).value);
  return p;
}

// Show/hide source-specific filters.
function syncFilterVisibility() {
  const s = $('f-source').value;
  document.querySelectorAll('[data-when="not-off"]').forEach((el) => (el.style.display = s === 'off' ? 'none' : ''));
  document.querySelectorAll('[data-when="not-usda"]').forEach((el) => (el.style.display = s === 'usda' ? 'none' : ''));
}

// Search fires on submit, not on every keystroke: Enter, or leaving the field
// (blur covers clicking elsewhere and Tab). This avoids slow partial-term
// queries. Blur only re-runs when the text changed; Enter always runs. Filter
// changes always re-run. State persists because switching pages only hides them.
let lastFoodQ = null, lastRecipeQ = null;
function triggerFood(force) {
  const v = foodQ.value.trim();
  if (!force && v === lastFoodQ) return;
  lastFoodQ = v; searchFood();
}
function triggerRecipe(force) {
  const v = recipeQ.value.trim();
  if (!force && v === lastRecipeQ) return;
  lastRecipeQ = v; searchRecipes();
}
foodQ.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); triggerFood(true); } });
foodQ.addEventListener('blur', () => triggerFood(false));
recipeQ.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); triggerRecipe(true); } });
recipeQ.addEventListener('blur', () => triggerRecipe(false));
document.querySelectorAll('#food-filters select, #food-filters input').forEach((el) => {
  el.addEventListener('change', () => { if (el.id === 'f-source') syncFilterVisibility(); triggerFood(true); });
});
document.querySelectorAll('#recipe-filters select').forEach((el) => {
  el.addEventListener('change', () => triggerRecipe(true));
});

// ── Top nav + URL state ────────────────────────────────────────────────────
// Each page tracks its own URL: a page base (/ or /recipes) when nothing is
// open, or a detail URL (/food/:src/:id, /recipe/:id) when a label/recipe is
// open. Switching pages reflects that page's current URL; opening/closing a
// detail updates it. The active page's URL is what the address bar shows.
const recipePanel = document.getElementById('recipe-panel');
const recipeEl = document.getElementById('recipe');
let activePage = 'food';
let foodUrl = '/';        // nutrition page URL (/, or /food/:src/:id)
let recipeUrl = '/recipes'; // recipe page URL (/recipes, or /recipe/:id)

function syncUrl(push) {
  const url = activePage === 'food' ? foodUrl : recipeUrl;
  if (url !== location.pathname) push ? history.pushState({}, '', url) : history.replaceState({}, '', url);
}

// ── Document title (reflects the open detail / active page) ────────────────
const BASE_TITLE = 'FoodLand.fyi — Food & Nutrition Database';
const RECIPE_TITLE = 'Recipe Search — FoodLand.fyi';
let foodTitle = BASE_TITLE, recipeTitle = RECIPE_TITLE;
function applyTitle() { document.title = activePage === 'food' ? foodTitle : recipeTitle; }

// ── Viewed results (color-changes them like visited links) ────────────────
let viewed = new Set();
try { viewed = new Set(JSON.parse(localStorage.getItem('viewed') || '[]')); } catch { /* ignore */ }
function markViewed(key) {
  viewed.add(key);
  try { localStorage.setItem('viewed', JSON.stringify([...viewed].slice(-3000))); } catch { /* ignore */ }
}

// ── "Load more" button helpers ────────────────────────────────────────────
const PAGE = 40;
function removeLoadMore(c) { const b = c.querySelector('.load-more'); if (b) b.remove(); }
function addLoadMore(c, fn) {
  removeLoadMore(c);
  const b = document.createElement('button');
  b.className = 'load-more';
  b.textContent = 'Load more';
  b.onclick = () => { b.disabled = true; b.textContent = 'Loading…'; fn(); };
  c.appendChild(b);
}

function showPage(p, push = true) {
  activePage = p;
  document.getElementById('page-food').hidden = p !== 'food';
  document.getElementById('page-recipe').hidden = p !== 'recipe';
  document.getElementById('nav-food').classList.toggle('active', p === 'food');
  document.getElementById('nav-recipe').classList.toggle('active', p === 'recipe');
  syncUrl(push);
  applyTitle();
  (p === 'food' ? foodQ : recipeQ).focus();
}
document.getElementById('nav-food').addEventListener('click', () => showPage('food'));
document.getElementById('nav-recipe').addEventListener('click', () => showPage('recipe'));

function closeLabel(push = true) {
  panelEl.hidden = true;
  foodUrl = '/'; foodTitle = BASE_TITLE;
  if (activePage === 'food') { syncUrl(push); applyTitle(); }
}
function closeRecipe(push = true) {
  recipePanel.hidden = true;
  recipeUrl = '/recipes'; recipeTitle = RECIPE_TITLE;
  if (activePage === 'recipe') { syncUrl(push); applyTitle(); }
}
document.getElementById('label-close').addEventListener('click', () => closeLabel());

// Back/forward: re-sync the UI to the URL without pushing a new entry.
window.addEventListener('popstate', () => applyPath(location.pathname));
function applyPath(path) {
  const rec = path.match(/^\/recipe\/(\d+)$/);
  const food = path.match(/^\/food\/([^/]+)\/(.+)$/);
  if (rec) { showPage('recipe', false); openRecipe(rec[1], false); }
  else if (path === '/recipes') { showPage('recipe', false); closeRecipe(false); }
  else if (food) { showPage('food', false); openLabel(decodeURIComponent(food[1]), decodeURIComponent(food[2]), null, false); }
  else { showPage('food', false); closeLabel(false); }
}

// Populate the category browse dropdown once.
fetch('/api/recipe-categories').then((r) => r.json()).then(({ categories }) => {
  const sel = $('r-category');
  for (const c of categories || []) sel.add(new Option(c, c));
}).catch(() => { /* leave just "All categories" */ });

let recipeOffset = 0;
async function searchRecipes(append = false) {
  const v = recipeQ.value.trim();
  const category = $('r-category').value;
  if (v.length < 3 && !category) { recipeResults.innerHTML = ''; return; }
  const offset = append ? recipeOffset : 0;
  const p = new URLSearchParams({ q: v, category, source: $('r-source').value, sort: $('r-sort').value, limit: PAGE, offset });
  const r = await fetch('/api/recipes?' + p.toString());
  if (!r.ok) { if (!append) recipeResults.innerHTML = '<div class="empty">…</div>'; return; }
  const { results, hasMore } = await r.json();
  removeLoadMore(recipeResults);
  if (!append) recipeResults.innerHTML = '';
  if (!append && !results.length) { recipeResults.innerHTML = '<div class="empty">No recipes found.</div>'; return; }
  for (const it of results) recipeResults.appendChild(makeRecipeRow(it));
  recipeOffset = offset + PAGE;
  if (hasMore) addLoadMore(recipeResults, () => searchRecipes(true));
}

function makeRecipeRow(it) {
  const a = document.createElement('a');
  a.className = 'result' + (viewed.has(`recipe:${it.id}`) ? ' viewed' : '');
  a.href = `/recipe/${it.id}`;
  const meta = [
    it.rating != null ? `★ ${(+it.rating).toFixed(1)}${it.review_count ? ` (${it.review_count})` : ''}` : '',
    it.minutes != null ? `${it.minutes} min` : '',
    it.calories != null ? `${Math.round(it.calories)} kcal/serv` : '',
    it.n_ingredients != null ? `${it.n_ingredients} ingredients` : '',
  ].filter(Boolean).join(' · ');
  const thumb = it.image ? `<img class="result-logo r-thumb" src="${esc(it.image)}" alt="" loading="lazy" />` : '';
  a.innerHTML = thumb +
    `<span class="result-main">` +
      `<span class="badge recipe">${it.source === 'foodcom' ? 'Food.com' : 'RecipeNLG'}</span>` +
      `<span class="title">${esc(it.title)}</span>` +
      `<div class="sub">${esc(meta)}</div>` +
    `</span>`;
  a.onclick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    markViewed(`recipe:${it.id}`); a.classList.add('viewed');
    openRecipe(it.id);
  };
  return a;
}

async function openRecipe(id, push = true) {
  recipePanel.hidden = false;
  recipeUrl = `/recipe/${id}`;
  if (activePage === 'recipe') syncUrl(push);
  recipeEl.innerHTML = '<p class="meta">loading…</p>';
  const r = await fetch('/api/recipe?id=' + encodeURIComponent(id));
  if (!r.ok) { recipeEl.innerHTML = '<p class="meta">Could not load.</p>'; return; }
  paintRecipe(await r.json());
  recipeEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Render the recipe and wire the collapsible nutrition (persisted) + close.
function paintRecipe(d) {
  recipeTitle = `${d.title} — Recipe | FoodLand.fyi`;
  if (activePage === 'recipe') applyTitle();
  recipeEl.innerHTML = renderRecipe(d);
  const det = recipeEl.querySelector('details.r-nutri');
  if (det) det.addEventListener('toggle', () => { try { localStorage.setItem('recipeNutriOpen', det.open ? '1' : '0'); } catch { /* ignore */ } });
  const close = recipeEl.querySelector('.r-close');
  if (close) close.onclick = () => closeRecipe();
}

// RecipeNLG stripped the "/" from fractions ("1/2"->"12", "2/3"->"23",
// "1 1/2"->"1 12"). Restore known cooking fractions: a whole+fraction pair, and
// a standalone fraction only before a small unit (so "1 (14 ounce) can" is safe).
const FRAC = { 12: '1/2', 13: '1/3', 23: '2/3', 14: '1/4', 34: '3/4', 18: '1/8', 38: '3/8', 58: '5/8', 78: '7/8', 25: '2/5', 35: '3/5', 45: '4/5' };
const FRAC_CODES = Object.keys(FRAC).join('|');
function fixFractions(s) {
  if (!s) return s;
  return String(s)
    .replace(new RegExp(`(\\d)\\s+(${FRAC_CODES})(?=\\s|$)`, 'g'), (_m, d, c) => `${d} ${FRAC[c]}`)
    .replace(new RegExp(`(^|\\s)(${FRAC_CODES})\\s+(cups?|teaspoons?|tablespoons?|tsp|tbsp)\\b`, 'gi'), (_m, pre, c, u) => `${pre}${FRAC[c]} ${u}`);
}

function renderRecipe(d) {
  const ing = (d.ingredients || []).map((x) => `<li>${esc(fixFractions(x))}</li>`).join('');
  const steps = (d.steps || []).map((x) => `<li>${esc(fixFractions(x))}</li>`).join('');
  const tags = (d.tags || []).slice(0, 16).map((x) => `<span class="r-tag">${esc(x)}</span>`).join('');
  const meta = [
    d.rating != null ? `★ ${(+d.rating).toFixed(1)}${d.review_count ? ` (${d.review_count} reviews)` : ''}` : '',
    d.minutes != null ? `${d.minutes} min` : '',
  ].filter(Boolean).join(' · ');
  // Per-serving nutrition card (Food.com only) — collapsible, state remembered.
  let nutri = '';
  if (d.calories != null) {
    const rows = [
      ['Calories', d.calories, '', 0], ['Fat', d.fat_g, 'g', 1], ['Saturated Fat', d.sat_fat_g, 'g', 1],
      ['Cholesterol', d.cholesterol_mg, 'mg', 0], ['Sodium', d.sodium_mg, 'mg', 0],
      ['Carbs', d.carbs_g, 'g', 1], ['Fiber', d.fiber_g, 'g', 1], ['Sugar', d.sugar_g, 'g', 1],
      ['Protein', d.protein_g, 'g', 1],
    ].filter(([, v]) => v != null)
      .map(([l, v, u, dp]) => `<tr><td>${l}</td><td>${(+v).toFixed(dp)}${u}</td></tr>`).join('');
    let open = true;
    try { open = localStorage.getItem('recipeNutriOpen') !== '0'; } catch { /* default open */ }
    nutri = `<details class="r-nutri"${open ? ' open' : ''}><summary>Nutrition <span>per serving</span></summary><table>${rows}</table></details>`;
  }
  const srcName = d.source === 'foodcom' ? 'Food.com' : 'RecipeNLG';
  const srcLink = d.source_url
    ? `<a href="${esc(d.source_url)}" target="_blank" rel="noopener">View original on ${srcName} ↗</a>` : '';
  return `
    <button type="button" class="r-close">✕</button>
    ${d.image ? `<img class="r-img" src="${esc(d.image)}" alt="${esc(d.title)}" loading="lazy" />` : ''}
    <h1 class="r-title">${esc(d.title)}</h1>
    ${d.category ? `<p class="r-cat">${esc(d.category)}</p>` : ''}
    ${meta ? `<p class="r-meta">${esc(meta)}</p>` : ''}
    ${d.description ? `<p class="r-desc">${esc(d.description)}</p>` : ''}
    ${tags ? `<div class="r-tags">${tags}</div>` : ''}
    ${nutri}
    <div class="r-cols">
      <div class="r-ing"><h3>Ingredients${d.n_ingredients ? ` (${d.n_ingredients})` : ''}</h3><ul>${ing || '<li class="meta">Not listed.</li>'}</ul></div>
      <div class="r-steps"><h3>Directions</h3><ol>${steps || '<li class="meta">Not listed.</li>'}</ol></div>
    </div>
    <p class="r-src">${srcLink} <span class="meta">· Recipe content belongs to its source; shown here with attribution.</span></p>`;
}

let foodOffset = 0;
async function searchFood(append = false) {
  const v = foodQ.value.trim();
  if (!isBarcode(v) && v.length < 3) { foodResults.innerHTML = ''; return; }
  const offset = append ? foodOffset : 0;
  const r = await fetch('/api/search?' + readFilters(v).toString() + `&limit=${PAGE}&offset=${offset}`);
  if (!r.ok) { if (!append) foodResults.innerHTML = '<div class="empty">…</div>'; return; }
  const { results, hasMore } = await r.json();
  removeLoadMore(foodResults);
  if (!append) foodResults.innerHTML = '';
  if (!append && !results.length) { foodResults.innerHTML = '<div class="empty">No matches.</div>'; return; }
  for (const item of results) foodResults.appendChild(makeFoodRow(item));
  foodOffset = offset + PAGE;
  if (hasMore) addLoadMore(foodResults, () => searchFood(true));
  loadLogos(foodResults);
}

function makeFoodRow(item) {
  const key = `food:${item.source}:${item.id}`;
  // Real link (crawlable, shareable, open-in-new-tab) — intercepted for the SPA.
  const b = document.createElement('a');
  b.className = 'result' + (viewed.has(key) ? ' viewed' : '');
  b.href = `/food/${item.source}/${encodeURIComponent(item.id)}`;
  const grade = nutriChip(item.grade);
  const kcal = item.kcal != null ? `<span class="kcal">${Math.round(item.kcal)} kcal/100g</span>` : '';
  const giChip = item.gi != null ? `<span class="gi-chip gi-${item.giCategory}">GI ${item.gi}</span>` : '';
  const vc = item.variantCount > 1 ? `<span class="vcount">· ${item.variantCount} variants</span>` : '';
  const logo = item.brand ? `<img class="result-logo" data-brand="${esc(item.brand)}" alt="" hidden />` : '';
  b.innerHTML = logo +
    `<span class="result-main">` +
      `<span class="badge ${item.source}">${item.source}</span>` +
      `<span class="title">${esc(item.title)}</span>${grade}${giChip}` +
      `<div class="sub">${esc(item.sub || '')}${kcal}${vc}</div>` +
    `</span>`;
  b.onclick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // let new-tab work
    e.preventDefault();
    markViewed(key); b.classList.add('viewed');
    openLabel(item.source, item.id, item.variants);
  };
  const cmp = document.createElement('button');
  cmp.className = 'cmp-btn';
  cmp.title = 'Add to comparison';
  cmp.textContent = inCompare(item) ? '✓' : '+';
  cmp.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleCompare(item); cmp.textContent = inCompare(item) ? '✓' : '+'; };
  b.appendChild(cmp);
  return b;
}

const cmpKey = (it) => `${it.source}:${it.id}`;
const inCompare = (it) => compareList.some((x) => cmpKey(x) === cmpKey(it));

function toggleCompare(item) {
  const i = compareList.findIndex((x) => cmpKey(x) === cmpKey(item));
  if (i >= 0) compareList.splice(i, 1);
  else if (compareList.length < 4) compareList.push({ source: item.source, id: item.id, title: item.title });
  renderCompareBar();
}

function renderCompareBar() {
  if (!compareList.length) { compareBar.hidden = true; return; }
  compareBar.hidden = false;
  compareBar.innerHTML =
    compareList.map((x, i) => `<span class="cmp-chip">${esc(x.title.slice(0, 28))}<button data-i="${i}" class="cmp-x">✕</button></span>`).join('') +
    `<button id="cmp-go" class="cmp-go">Compare ${compareList.length}</button>` +
    `<button id="cmp-clear" class="cmp-clear">Clear</button>`;
  compareBar.querySelectorAll('.cmp-x').forEach((b) => (b.onclick = () => { compareList.splice(Number(b.dataset.i), 1); renderCompareBar(); }));
  document.getElementById('cmp-go').onclick = openCompare;
  document.getElementById('cmp-clear').onclick = () => { compareList.length = 0; renderCompareBar(); };
}

async function openCompare() {
  compareModal.hidden = false;
  compareLabels.innerHTML = '<p class="meta" style="padding:1rem">Loading…</p>';
  const labels = await Promise.all(compareList.map(async (x) => {
    const r = await fetch(`/api/food?source=${x.source}&id=${encodeURIComponent(x.id)}`);
    return r.ok ? r.json() : null;
  }));
  // Render every label defaulting to its 100 g serving for a fair comparison.
  // Reuse paintLabel so each column's serving dropdown re-scales on change.
  compareLabels.innerHTML = '';
  for (const d of labels.filter(Boolean)) {
    const col = document.createElement('div');
    col.className = 'cmp-col';
    const idx = Math.max(0, (d.servings || []).findIndex((s) => s.grams === 100));
    paintLabel(col, d, idx);
    compareLabels.appendChild(col);
  }
}

document.getElementById('compare-close').onclick = () => { compareModal.hidden = true; };

async function openLabel(source, id, variants, push = true) {
  panelEl.hidden = false;
  foodUrl = `/food/${source}/${encodeURIComponent(id)}`;
  if (activePage === 'food') syncUrl(push);
  // Merged USDA results expose multiple entries — let the user pick which one.
  let header = '';
  if (variants && variants.length > 1) {
    header =
      `<label class="variant-pick">Serving / variant (${variants.length})
        <select id="variant-select">` +
      variants.map((v) => `<option value="${esc(v.id)}">${esc(v.serving)}</option>`).join('') +
      `</select></label>`;
  }
  labelEl.innerHTML = header + '<div id="label-body"><p class="meta">loading…</p></div>';
  if (variants && variants.length > 1) {
    const sel = document.getElementById('variant-select');
    sel.value = id;
    sel.addEventListener('change', () => renderInto(source, sel.value));
  }
  renderInto(source, id);
}

async function renderInto(source, id) {
  const body = document.getElementById('label-body');
  const r = await fetch(`/api/food?source=${source}&id=${encodeURIComponent(id)}`);
  if (!r.ok) { body.innerHTML = '<p class="meta">Could not load.</p>'; return; }
  const d = await r.json();
  // Default to the product's own serving (server lists it first for branded
  // foods with known grams); otherwise the first option is 100 g.
  paintLabel(body, d, 0);
}

// Render the label at serving index `idx`, wiring the serving dropdown to
// re-render (and recalculate every value) when a different serving is picked.
function paintLabel(body, d, idx) {
  foodTitle = `${d.title} — Nutrition Facts | FoodLand.fyi`;
  if (activePage === 'food') applyTitle();
  body.innerHTML = renderLabel(d, idx);
  const sel = body.querySelector('#serving-select');
  if (sel) { sel.selectedIndex = idx; sel.onchange = () => paintLabel(body, d, sel.selectedIndex); }
  loadLogos(body);
}

// Fill brand-logo <img> placeholders from the cached /api/logo endpoint.
async function loadLogos(root) {
  for (const img of root.querySelectorAll('img[data-brand]:not([data-done])')) {
    img.dataset.done = '1';
    try {
      const { url } = await (await fetch('/api/logo?brand=' + encodeURIComponent(img.dataset.brand))).json();
      if (url) { img.src = url; img.alt = img.dataset.brand; img.hidden = false; }
    } catch { /* leave hidden */ }
  }
}

// One label row: label text (+amount) and a %DV cell.
function row(cls, label, field, n, { bold = false } = {}) {
  const v = n[field];
  const amount = v == null ? '' : ` ${fmt(v, UNIT[field])}`;
  const name = bold ? `<b>${label}</b>` : label;
  return `<tr><td class="${cls}">${name}${amount}</td><td class="dv">${dv(field, v)}</td></tr>`;
}

function renderLabel(d, idx = 0) {
  const servings = d.servings && d.servings.length ? d.servings : [{ label: '100 g', grams: 100 }];
  const grams = servings[idx]?.grams ?? 100;
  const factor = grams / 100;
  // Scale every per-100g value to the chosen serving.
  const n = {};
  for (const k in d.n) n[k] = d.n[k] == null ? null : d.n[k] * factor;

  const cal = n.energyKcal == null ? '—' : Math.round(n.energyKcal);
  const added = n.addedSugars == null ? '' :
    `<tr><td class="ind2">Includes ${fmt(n.addedSugars, 'g')} Added Sugars</td><td class="dv">${dv('addedSugars', n.addedSugars)}</td></tr>`;

  // Micros only render when present (USDA has them; OFF usually doesn't).
  const micros = ['vitaminD', 'calcium', 'iron', 'potassium', 'vitaminC']
    .filter((f) => n[f] != null)
    .map((f) => {
      const names = { vitaminD: 'Vitamin D', calcium: 'Calcium', iron: 'Iron', potassium: 'Potassium', vitaminC: 'Vitamin C' };
      return `<tr><td>${names[f]} ${fmt(n[f], UNIT[f])}</td><td class="dv">${dv(f, n[f])}</td></tr>`;
    }).join('');

  const options = servings.map((s, i) => `<option value="${i}">${esc(s.label)}</option>`).join('');

  // Nutri-Score + NOVA processing chips (OFF only), shown right of the serving.
  const grades = nutriChip(d.grade) + novaChip(d.nova);
  const netCarbs = n.carbs == null ? null : Math.max(0, n.carbs - (n.fiber || 0));
  const netRow = netCarbs == null ? '' :
    `<tr><td class="ind net-carbs" title="Net carbs = Total Carbohydrate − Dietary Fiber">Net Carbs ${fmt(netCarbs, 'g')}</td><td class="dv"></td></tr>`;

  // Compact summary strip (macro ring + GI/GL chips) shown just below serving.
  const top = macroRing(n) + glyChips(n, d);

  return `
  <div class="nf">
    ${d.brand ? `<img class="nf-logo" data-brand="${esc(d.brand)}" alt="" hidden />` : ''}
    ${d.brand ? `<p class="brand">${esc(d.brand)}</p>` : ''}
    <p class="name">${esc(d.title)}</p>
    <p class="title">Nutrition Facts</p>
    <p class="serving">Amount per <select id="serving-select" class="serving-select">${options}</select>${grades ? `<span class="nf-grades">${grades}</span>` : ''}</p>
    ${top ? `<div class="nf-top">${top}</div>` : ''}
    <div class="bar"></div>
    <div class="cal-row"><span class="lbl">Calories</span><span class="val">${cal}</span></div>
    <p class="dv-head">% Daily Value*</p>
    <table>
      ${row('', 'Total Fat', 'fat', n, { bold: true })}
      ${row('ind', 'Saturated Fat', 'satFat', n)}
      ${n.transFat != null ? `<tr><td class="ind"><i>Trans</i> Fat ${fmt(n.transFat, 'g')}</td><td class="dv"></td></tr>` : ''}
      ${row('', 'Cholesterol', 'cholesterol', n, { bold: true })}
      ${row('', 'Sodium', 'sodium', n, { bold: true })}
      ${row('', 'Total Carbohydrate', 'carbs', n, { bold: true })}
      ${row('ind', 'Dietary Fiber', 'fiber', n)}
      ${netRow}
      ${n.sugars != null ? `<tr><td class="ind sugar-line" role="button" tabindex="0" data-sugar="${(+n.sugars).toFixed(2)}" data-grams="${grams}">Total Sugars ${fmt(n.sugars, 'g')}</td><td class="dv"></td></tr>` : ''}
      ${added}
      <tr class="thick">${`<td><b>Protein</b>${n.protein == null ? '' : ' ' + fmt(n.protein, 'g')}</td><td class="dv"></td>`}</tr>
      ${micros}
    </table>
    ${micros ? '' : '<p class="na">Vitamin/mineral detail not available for this source.</p>'}
    ${detailViz(d.detail, factor)}
    <p class="footnote">* The % Daily Value tells you how much a nutrient in a serving contributes to a daily diet. 2,000 calories a day is used for general nutrition advice.</p>
    ${d.allergens && d.allergens.length ? `<p class="nf-allergens"><b>Allergens:</b> ${d.allergens.map(esc).join(', ')}</p>` : ''}
    ${d.diet && d.diet.length ? `<p class="nf-diet">${d.diet.map((x) => `<span class="diet-badge">${esc(x)}</span>`).join('')}</p>` : ''}
    ${ingredientsHtml(d.ingredients)}
  </div>`;
}

// Extended nutrients (USDA whole foods), rendered inside the label as one
// collapsible block per section. Amounts are per-100g from the API; scaled to
// the chosen serving like the rest of the label.
function detailViz(detail, factor) {
  if (!detail || !detail.length) return '';
  const fmtAmt = (v, u) => {
    const x = v * factor;
    const dp = x >= 10 ? 1 : x >= 1 ? 2 : 3;
    return `${x.toLocaleString(undefined, { maximumFractionDigits: dp })} ${u}`;
  };
  const secs = detail.map((sec) => {
    const rows = sec.items.map((it) => `<tr><td>${esc(it.label)}</td><td>${fmtAmt(it.amount, it.unit)}</td></tr>`).join('');
    return `<details class="nf-detail"><summary>${esc(sec.title)}</summary><table class="detail-table">${rows}</table></details>`;
  }).join('');
  return `<div class="nf-detail-group">${secs}</div>`;
}

// Compact Glycemic Index / Load chips (shown in the top strip when GI is known).
function glyChips(n, d) {
  if (n.carbs == null || d.gi == null) return '';
  const net = Math.max(0, n.carbs - (n.fiber || 0));
  const gl = (d.gi * net) / 100;
  const glCat = gl <= 10 ? 'low' : gl <= 19 ? 'medium' : 'high';
  const glText = gl.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return `<div class="gly-chips">`
    + `<span class="gly-chip gi-${d.giCategory}" title="Glycemic Index (${d.giCategory}) — from published tables (≈ &quot;${esc(d.giSource || '')}&quot;)">GI ${d.gi}</span>`
    + `<span class="gly-chip gi-${glCat}" title="Glycemic Load (${glCat}) = GI × net carbs ÷ 100, per serving">GL ${glText}</span>`
    + `</div>`;
}

// Render ~4 g sugar cubes for a sugar amount (used inside the sugar popup).
function sugarCubes(sugars) {
  const count = Math.round(sugars / 4);
  const shown = Math.min(Math.max(count, 1), 40);
  const icons = Array.from({ length: shown }, () => '<span class="cube"></span>').join('');
  const more = count > shown ? `<span class="cube-more">+${count - shown}</span>` : '';
  return `<div class="sugar-cubes">${icons}${more}</div>`;
}

// Ingredients line with flagged-additive warnings (hover for details).
function ingredientsHtml(raw) {
  if (!raw) return '';
  // OFF ingredient text sometimes contains HTML (e.g. <span class="allergen">…</span>); strip it.
  raw = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const { html, count } = highlightAdditives(raw);
  const warn = count > 0
    ? `<p class="additive-note">⚠ ${count} flagged additive${count === 1 ? '' : 's'} — tap for details</p>` : '';
  return `${warn}<p class="ingredients"><b>Ingredients:</b> ${html}</p>`;
}

// Macro calorie breakdown ring (fat 9 kcal/g, carbs & protein 4 kcal/g).
function macroRing(n) {
  const fatC = (n.fat || 0) * 9, carbC = (n.carbs || 0) * 4, protC = (n.protein || 0) * 4;
  const total = fatC + carbC + protC;
  if (total <= 0) return '';
  const pct = (x) => Math.round((x / total) * 100);
  const cDeg = (carbC / total) * 360, fDeg = (fatC / total) * 360;
  const ring = `conic-gradient(#5b8def 0 ${cDeg}deg, #f2b14c ${cDeg}deg ${cDeg + fDeg}deg, #5fbf77 ${cDeg + fDeg}deg 360deg)`;
  return `
    <div class="macros">
      <div class="ring" style="background:${ring}"><span class="ring-hole"></span></div>
      <ul class="macro-legend">
        <li><i style="background:#5b8def"></i>Carbs ${pct(carbC)}%</li>
        <li><i style="background:#f2b14c"></i>Fat ${pct(fatC)}%</li>
        <li><i style="background:#5fbf77"></i>Protein ${pct(protC)}%</li>
      </ul>
    </div>`;
}

// ── Info popups: show the server-rendered /leaders and /developers pages
// in a modal instead of navigating (the real pages stay for SEO/direct links).
const infoModal = document.getElementById('info-modal');
const infoContent = document.getElementById('info-content');

async function openInfo(url) {
  infoModal.hidden = false;
  infoContent.innerHTML = '<p class="meta" style="padding:1rem">Loading…</p>';
  try {
    const html = await (await fetch(url)).text();
    const page = new DOMParser().parseFromString(html, 'text/html').querySelector('.page');
    infoContent.innerHTML = page ? page.outerHTML : '<p class="meta" style="padding:1rem">Could not load.</p>';
    wireInfoLinks();
    infoContent.scrollTop = 0;
  } catch {
    infoContent.innerHTML = '<p class="meta" style="padding:1rem">Could not load.</p>';
  }
}

function wireInfoLinks() {
  infoContent.querySelectorAll('a[href^="/leaders"]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); openInfo(a.getAttribute('href')); };
  });
  infoContent.querySelectorAll('a[href^="/food/"]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      const m = a.getAttribute('href').match(/\/food\/(usda|off)\/(.+)$/);
      if (m) { infoModal.hidden = true; showLabel(m[1], decodeURIComponent(m[2])); }
    };
  });
}

document.getElementById('info-close').onclick = () => { infoModal.hidden = true; };
infoModal.onclick = (e) => { if (e.target === infoModal) infoModal.hidden = true; };

// ── Flagged-additive popup: blurb + links to scientific study searches.
function openAdditiveInfo(term) {
  additiveMatcher();
  const a = ADDITIVE_MAP && ADDITIVE_MAP.get(term);
  if (!a) return;
  const name = a.terms[0];
  const q = encodeURIComponent(name + ' food additive health');
  const sev = a.severity === 'avoid' ? 'Avoid' : 'Caution';
  const aka = a.terms.slice(1).join(', ');
  infoContent.innerHTML = `
    <div class="additive-pop">
      <h2>${esc(name)} <span class="additive-badge ${a.severity}">${sev}</span></h2>
      ${aka ? `<p class="additive-aka">Also: ${esc(aka)}</p>` : ''}
      <p class="additive-blurb">${esc(a.note)}</p>
      <p class="additive-links-head"><b>Research this ingredient</b></p>
      <ul class="additive-links">
        <li><a href="https://pubmed.ncbi.nlm.nih.gov/?term=${q}" target="_blank" rel="noopener">PubMed ↗</a></li>
        <li><a href="https://scholar.google.com/scholar?q=${q}" target="_blank" rel="noopener">Google Scholar ↗</a></li>
        <li><a href="https://europepmc.org/search?query=${q}" target="_blank" rel="noopener">Europe PMC ↗</a></li>
      </ul>
      <p class="additive-disclaimer">Flags reflect regulatory actions and published assessments — not medical advice.</p>
    </div>`;
  infoModal.hidden = false;
  infoContent.scrollTop = 0;
}
// ── Sugar-cube popup: cube count + everyday sugar equivalents. Typical added
// sugar per common item (grams), used to make the serving's sugar relatable.
const SUGAR_REFS = [
  { name: 'regular Snickers bar', plural: 'regular Snickers bars', g: 27 },
  { name: '12 oz can of Coca-Cola', plural: '12 oz cans of Coca-Cola', g: 39 },
  { name: 'glazed donut', plural: 'glazed donuts', g: 10 },
  { name: 'Oreo cookie', plural: 'Oreo cookies', g: 4.6 },
  { name: 'teaspoon of sugar', plural: 'teaspoons of sugar', g: 4.2 },
];
function fmtRatio(n) { return n >= 10 ? Math.round(n) : +n.toFixed(1); }

function openSugarInfo(grams, servingGrams) {
  const g = +grams;
  if (!(g > 0)) return;
  const cubes = Math.round(g / 4);
  const snick = fmtRatio(g / 27);
  const sg = +servingGrams;
  const pct = sg > 0 ? Math.round((g / sg) * 100) : null;
  const others = SUGAR_REFS.filter((r) => r.g !== 27)
    .map((r) => ({ r, v: fmtRatio(g / r.g) }))
    .filter((x) => x.v >= 0.1);
  infoContent.innerHTML = `
    <div class="sugar-pop">
      <h2>Sugar <span class="sugar-amt">${g.toFixed(1)} g</span></h2>
      <p class="sugar-cube-line">≈ ${cubes} sugar cube${cubes === 1 ? '' : 's'} (1 cube ≈ 4 g)</p>
      ${sugarCubes(g)}
      ${pct != null ? `<p class="sugar-pct"><b>${pct}%</b> of this serving is sugar by weight.</p>` : ''}
      <p class="sugar-lead">This serving has about the same sugar as
        <b>${snick} ${snick === 1 ? 'regular Snickers bar' : 'regular Snickers bars'}</b>.</p>
      <p class="sugar-eq-head"><b>Other everyday equivalents</b></p>
      <ul class="sugar-eq">
        ${others.map(({ r, v }) => `<li><b>${v}×</b> ${esc(v === 1 ? r.name : r.plural)} <span class="sugar-eq-sub">(${r.g} g each)</span></li>`).join('')}
      </ul>
      <p class="additive-disclaimer">Equivalents are approximate, using typical sugar content per item.</p>
    </div>`;
  infoModal.hidden = false;
  infoContent.scrollTop = 0;
}

// ── Top spices by cuisine popup (Food.com cuisine categories).
let SPICE_DATA = null;
async function openCuisineSpices() {
  infoModal.hidden = false;
  infoContent.innerHTML = '<p class="meta" style="padding:1rem">Loading…</p>';
  infoContent.scrollTop = 0;
  try {
    if (!SPICE_DATA) SPICE_DATA = await (await fetch('/api/cuisine-spices')).json();
    const cards = (SPICE_DATA.cuisines || []).map((c) => `
      <div class="cuisine-card">
        <h3>${esc(c.cuisine)} <span class="cuisine-n">${c.recipes.toLocaleString()} recipes</span></h3>
        <ul>${c.spices.map((s) => `<li><span class="spice-name">${esc(s.name)}</span><span class="spice-bar"><span style="width:${s.pct}%"></span></span><span class="spice-pct">${s.pct}%</span></li>`).join('')}</ul>
      </div>`).join('');
    infoContent.innerHTML = `
      <div class="spice-pop">
        <h2>Top spices by cuisine</h2>
        <p class="spice-intro">Share of each cuisine's recipes that use a given spice or herb. Based on Food.com recipes tagged by cuisine.</p>
        <div class="cuisine-grid">${cards || '<p class="meta">No data.</p>'}</div>
      </div>`;
    infoContent.scrollTop = 0;
  } catch {
    infoContent.innerHTML = '<p class="meta" style="padding:1rem">Could not load.</p>';
  }
}
$('spice-btn')?.addEventListener('click', openCuisineSpices);

document.addEventListener('click', (e) => {
  if (!e.target.closest) return;
  const add = e.target.closest('.additive-warn');
  if (add) { e.preventDefault(); openAdditiveInfo(add.dataset.term); return; }
  const sug = e.target.closest('.sugar-line');
  if (sug) { e.preventDefault(); openSugarInfo(sug.dataset.sugar, sug.dataset.grams); }
});
document.addEventListener('keydown', (e) => {
  if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.closest) return;
  const add = e.target.closest('.additive-warn');
  if (add) { e.preventDefault(); openAdditiveInfo(add.dataset.term); return; }
  const sug = e.target.closest('.sugar-line');
  if (sug) { e.preventDefault(); openSugarInfo(sug.dataset.sugar, sug.dataset.grams); }
});
document.querySelectorAll('footer a[href="/leaders"], footer a[href="/developers"]').forEach((a) => {
  a.onclick = (e) => { e.preventDefault(); openInfo(a.getAttribute('href')); };
});

syncFilterVisibility();

// Hydrate from a server-rendered permalink, seeding each page's URL state.
if (window.__FOOD__) {
  panelEl.hidden = false;
  foodUrl = location.pathname;
  const body = document.getElementById('label-body');
  if (body) paintLabel(body, window.__FOOD__, 0);
} else if (window.__RECIPE__) {
  recipeUrl = location.pathname;
  recipePanel.hidden = false;
  paintRecipe(window.__RECIPE__);
  showPage('recipe', false);
} else if (location.pathname === '/recipes') {
  showPage('recipe', false);
}
