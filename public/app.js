const qEl = document.getElementById('q');
const resultsEl = document.getElementById('results');
const panelEl = document.getElementById('label-panel');
const labelEl = document.getElementById('label');
const statsEl = document.getElementById('stats');
const compareBar = document.getElementById('compare-bar');
const compareModal = document.getElementById('compare-modal');
const compareLabels = document.getElementById('compare-labels');
const compareList = []; // {source, id, title}

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

// Escape ingredient text, then wrap flagged additives with a hover-warning span.
function highlightAdditives(raw) {
  additiveMatcher();
  let count = 0;
  if (!ADDITIVE_RE) return { html: esc(raw), count };
  const html = esc(raw).replace(ADDITIVE_RE, (m) => {
    const a = ADDITIVE_MAP.get(m.toLowerCase());
    if (!a) return m;
    count++;
    const tip = (a.severity === 'avoid' ? 'AVOID — ' : 'Caution — ') + a.note;
    return `<span class="additive-warn ${a.severity}" title="${esc(tip)}">${m}</span>`;
  });
  return { html, count };
}
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
    const cmp = document.createElement('button');
    cmp.className = 'cmp-btn';
    cmp.title = 'Add to comparison';
    cmp.textContent = inCompare(item) ? '✓' : '+';
    cmp.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleCompare(item); cmp.textContent = inCompare(item) ? '✓' : '+'; };
    b.appendChild(cmp);
    resultsEl.appendChild(b);
  }
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
  // Render every label at its 100 g serving for a fair comparison.
  compareLabels.innerHTML = labels.filter(Boolean).map((d) => {
    const idx = Math.max(0, (d.servings || []).findIndex((s) => s.grams === 100));
    return `<div class="cmp-col">${renderLabel(d, idx)}</div>`;
  }).join('');
}

document.getElementById('compare-close').onclick = () => { compareModal.hidden = true; };

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
  const dl = body.querySelector('.dl-label');
  if (dl) dl.onclick = () => downloadLabel(body, d);
}

// Rasterize the live FDA label node to a PNG and download it. Captures the
// on-screen (laid-out) node — cloning off-screen renders blank.
async function downloadLabel(body, d) {
  const nf = body.querySelector('.nf');
  if (!nf || !window.htmlToImage) return;
  // Temporarily swap the serving dropdown for plain text so the image is clean.
  const sel = nf.querySelector('#serving-select');
  let span = null;
  if (sel) {
    span = document.createElement('span');
    span.textContent = sel.options[sel.selectedIndex]?.text ?? '';
    span.style.fontWeight = 'bold';
    sel.style.display = 'none';
    sel.insertAdjacentElement('afterend', span);
  }
  // skipFonts avoids html-to-image hanging while it tries to inline external
  // stylesheets/fonts; the label uses system fonts (Helvetica/Arial) anyway.
  const opts = { pixelRatio: 2, backgroundColor: '#ffffff', skipFonts: true, style: { margin: '0' } };
  try {
    // html-to-image's first pass(es) can come out blank in Chrome — render a
    // few times and keep the last, biggest result.
    let url = '';
    for (let i = 0; i < 3; i++) {
      const u = await window.htmlToImage.toPng(nf, opts);
      if (u.length >= url.length) url = u;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = (d?.title || 'nutrition-facts').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) + '-nutrition-facts.png';
    a.click();
  } catch (e) {
    console.error('label download failed', e);
  } finally {
    if (span) span.remove();
    if (sel) sel.style.display = '';
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
    ${ingredientsHtml(d.ingredients)}
  </div>
  ${glyViz(n, d)}
  ${sugarViz(n.sugars)}
  <button type="button" class="dl-label">⬇ Download label as image</button>`;
}

// Diabetic-relevant block: net carbs (always), plus GI/GL when GI is known.
function glyViz(n, d) {
  if (n.carbs == null) return '';
  const net = Math.max(0, n.carbs - (n.fiber || 0));
  let cards = `<div class="gly-card"><span class="gly-n">${net.toLocaleString(undefined, { maximumFractionDigits: 1 })}g</span><span class="gly-l">Net carbs</span></div>`;
  let src;
  if (d.gi != null) {
    const gl = (d.gi * net) / 100;
    const glCat = gl <= 10 ? 'low' : gl <= 19 ? 'medium' : 'high';
    cards += `<div class="gly-card"><span class="gly-n gi-${d.giCategory}">${d.gi}</span><span class="gly-l">Glycemic Index · ${d.giCategory}</span></div>`;
    cards += `<div class="gly-card"><span class="gly-n gi-${glCat}">${gl.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span><span class="gly-l">Glycemic Load · ${glCat}</span></div>`;
    src = `<p class="gly-src">GI from published tables (≈ "${esc(d.giSource)}"). GL = GI × net carbs ÷ 100, per serving.</p>`;
  } else {
    src = `<p class="gly-src">Net carbs = total carbs − fiber. Glycemic index not available for this food.</p>`;
  }
  return `<div class="gly-viz"><div class="gly-grid">${cards}</div>${src}</div>`;
}

// Visualize sugar as ~4 g sugar cubes for the current serving.
function sugarViz(sugars) {
  if (sugars == null || sugars <= 0) return '';
  const count = Math.round(sugars / 4);
  const shown = Math.min(Math.max(count, 1), 40);
  const icons = Array.from({ length: shown }, () => '<span class="cube"></span>').join('');
  const more = count > shown ? `<span class="cube-more">+${count - shown}</span>` : '';
  const label = count >= 1 ? `${count} sugar cube${count === 1 ? '' : 's'}` : 'under 1 sugar cube';
  return `<div class="sugar-viz">
    <div class="sugar-cubes">${icons}${more}</div>
    <p class="sugar-cap">≈ ${label} · ${(+sugars).toFixed(1)} g sugar <span class="cube-note">(1 cube ≈ 4 g)</span></p>
  </div>`;
}

// Ingredients line with flagged-additive warnings (hover for details).
function ingredientsHtml(raw) {
  if (!raw) return '';
  // OFF ingredient text sometimes contains HTML (e.g. <span class="allergen">…</span>); strip it.
  raw = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const { html, count } = highlightAdditives(raw);
  const warn = count > 0
    ? `<p class="additive-note">⚠ ${count} flagged additive${count === 1 ? '' : 's'} — hover for details</p>` : '';
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
document.querySelectorAll('footer a[href="/leaders"], footer a[href="/developers"]').forEach((a) => {
  a.onclick = (e) => { e.preventDefault(); openInfo(a.getAttribute('href')); };
});

syncFilterVisibility();
loadStats();

// On a server-rendered /food/:source/:id page, hydrate the interactive label
// (serving dropdown, macro ring, %DV) over the crawlable summary.
if (window.__FOOD__) {
  panelEl.hidden = false;
  const body = document.getElementById('label-body');
  if (body) paintLabel(body, window.__FOOD__, 0);
}
