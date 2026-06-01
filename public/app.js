const qEl = document.getElementById('q');
const resultsEl = document.getElementById('results');
const panelEl = document.getElementById('label-panel');
const labelEl = document.getElementById('label');
const statsEl = document.getElementById('stats');

// FDA Daily Values (2,000 kcal) and display units per normalized field.
const DV = { fat: 78, satFat: 20, cholesterol: 300, sodium: 2300, carbs: 275,
  fiber: 28, addedSugars: 50, vitaminD: 20, calcium: 1300, iron: 18, potassium: 4700, vitaminC: 90 };
const UNIT = { fat: 'g', satFat: 'g', transFat: 'g', cholesterol: 'mg', sodium: 'mg',
  carbs: 'g', fiber: 'g', sugars: 'g', addedSugars: 'g', protein: 'g',
  vitaminD: 'mcg', calcium: 'mg', iron: 'mg', potassium: 'mg', vitaminC: 'mg' };

function esc(s) { const e = document.createElement('div'); e.textContent = s ?? ''; return e.innerHTML; }
function fmt(v, unit) { return v == null ? null : `${(+v).toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit}`; }
function dv(field, v) { return v == null || !DV[field] ? '' : Math.round((v / DV[field]) * 100) + '%'; }

async function loadStats() {
  try {
    const s = await (await fetch('/api/stats')).json();
    const total = (s.usda || 0) + (s.off || 0);
    statsEl.innerHTML =
      `<b>${total.toLocaleString()}</b> foods in the database` +
      ` · ${s.usda.toLocaleString()} USDA · ${s.off.toLocaleString()} Open Food Facts`;
  } catch { statsEl.textContent = ''; }
}

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

let timer;
qEl.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
// Re-run immediately when any filter changes.
document.querySelectorAll('.filters select, .filters input').forEach((el) => {
  el.addEventListener('change', () => { if (el.id === 'f-source') syncFilterVisibility(); search(); });
});

async function search() {
  const v = qEl.value.trim();
  if (!isBarcode(v) && v.length < 3) { resultsEl.innerHTML = ''; return; }
  const r = await fetch('/api/search?' + readFilters(v).toString());
  if (!r.ok) { resultsEl.innerHTML = '<div class="empty">…</div>'; return; }
  const { results } = await r.json();
  if (!results.length) { resultsEl.innerHTML = '<div class="empty">No matches.</div>'; return; }
  resultsEl.innerHTML = '';
  for (const item of results) {
    // Real link (crawlable, shareable, open-in-new-tab) — intercepted for the SPA.
    const b = document.createElement('a');
    b.className = 'result';
    b.href = `/food/${item.source}/${encodeURIComponent(item.id)}`;
    const grade = item.grade && /^[a-e]$/.test(item.grade)
      ? `<span class="nutri nutri-${item.grade}">${item.grade.toUpperCase()}</span>` : '';
    const kcal = item.kcal != null ? `<span class="kcal">${Math.round(item.kcal)} kcal/100g</span>` : '';
    const vc = item.variantCount > 1 ? `<span class="vcount">· ${item.variantCount} variants</span>` : '';
    b.innerHTML =
      `<span class="badge ${item.source}">${item.source}</span>` +
      `<span class="title">${esc(item.title)}</span>${grade}` +
      `<div class="sub">${esc(item.sub || '')}${kcal}${vc}</div>`;
    b.onclick = (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // let new-tab work
      e.preventDefault();
      showLabel(item.source, item.id, item.variants);
      history.pushState({}, '', b.href);
    };
    resultsEl.appendChild(b);
  }
}

async function showLabel(source, id, variants) {
  panelEl.hidden = false;
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
  paintLabel(body, await r.json(), 0);
}

// Render the label at serving index `idx`, wiring the serving dropdown to
// re-render (and recalculate every value) when a different serving is picked.
function paintLabel(body, d, idx) {
  body.innerHTML = renderLabel(d, idx);
  const sel = body.querySelector('#serving-select');
  if (sel) { sel.selectedIndex = idx; sel.onchange = () => paintLabel(body, d, sel.selectedIndex); }
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

  // Nutri-Score + NOVA processing badges (OFF only).
  const badges =
    (d.grade ? `<span class="nutri nutri-${d.grade}">Nutri-Score ${d.grade.toUpperCase()}</span>` : '') +
    (d.nova ? `<span class="nova nova-${d.nova}">NOVA ${d.nova} · ${['','unprocessed','processed culinary','processed','ultra-processed'][d.nova] || ''}</span>` : '');

  return `
  <div class="nf">
    ${d.brand ? `<p class="brand">${esc(d.brand)}</p>` : ''}
    <p class="name">${esc(d.title)}</p>
    ${badges ? `<p class="nf-badges">${badges}</p>` : ''}
    <p class="title">Nutrition Facts</p>
    <p class="serving">Amount per <select id="serving-select" class="serving-select">${options}</select></p>
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
      ${n.sugars != null ? `<tr><td class="ind">Total Sugars ${fmt(n.sugars, 'g')}</td><td class="dv"></td></tr>` : ''}
      ${added}
      <tr class="thick">${`<td><b>Protein</b>${n.protein == null ? '' : ' ' + fmt(n.protein, 'g')}</td><td class="dv"></td>`}</tr>
      ${micros}
    </table>
    ${micros ? '' : '<p class="na">Vitamin/mineral detail not available for this source.</p>'}
    ${macroRing(n)}
    <p class="footnote">* The % Daily Value tells you how much a nutrient in a serving contributes to a daily diet. 2,000 calories a day is used for general nutrition advice.</p>
    ${d.allergens && d.allergens.length ? `<p class="nf-allergens"><b>Allergens:</b> ${d.allergens.map(esc).join(', ')}</p>` : ''}
    ${d.diet && d.diet.length ? `<p class="nf-diet">${d.diet.map((x) => `<span class="diet-badge">${esc(x)}</span>`).join('')}</p>` : ''}
    ${d.ingredients ? `<p class="ingredients"><b>Ingredients:</b> ${esc(d.ingredients)}</p>` : ''}
  </div>`;
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

syncFilterVisibility();
loadStats();

// On a server-rendered /food/:source/:id page, hydrate the interactive label
// (serving dropdown, macro ring, %DV) over the crawlable summary.
if (window.__FOOD__) {
  panelEl.hidden = false;
  const body = document.getElementById('label-body');
  if (body) paintLabel(body, window.__FOOD__, 0);
}
