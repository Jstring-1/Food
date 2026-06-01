const qEl = document.getElementById('q');
const resultsEl = document.getElementById('results');
const panelEl = document.getElementById('label-panel');
const labelEl = document.getElementById('label');
const statsEl = document.getElementById('stats');

// FDA Daily Values (2,000 kcal) and display units per normalized field.
const DV = { fat: 78, satFat: 20, cholesterol: 300, sodium: 2300, carbs: 275,
  fiber: 28, addedSugars: 50, vitaminD: 20, calcium: 1300, iron: 18, potassium: 4700 };
const UNIT = { fat: 'g', satFat: 'g', transFat: 'g', cholesterol: 'mg', sodium: 'mg',
  carbs: 'g', fiber: 'g', sugars: 'g', addedSugars: 'g', protein: 'g',
  vitaminD: 'mcg', calcium: 'mg', iron: 'mg', potassium: 'mg' };

function esc(s) { const e = document.createElement('div'); e.textContent = s ?? ''; return e.innerHTML; }
function fmt(v, unit) { return v == null ? null : `${(+v).toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit}`; }
function dv(field, v) { return v == null || !DV[field] ? '' : Math.round((v / DV[field]) * 100) + '%'; }

async function loadStats() {
  try {
    const s = await (await fetch('/api/stats')).json();
    const total = (s.usda || 0) + (s.off || 0);
    statsEl.innerHTML =
      `<b>${total.toLocaleString()}</b> foods in the database` +
      ` &nbsp;·&nbsp; ${s.usda.toLocaleString()} USDA · ${s.off.toLocaleString()} Open Food Facts`;
  } catch { statsEl.textContent = ''; }
}

let timer;
qEl.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });

async function search() {
  const v = qEl.value.trim();
  if (v.length < 2) { resultsEl.innerHTML = ''; return; }
  const r = await fetch('/api/search?q=' + encodeURIComponent(v));
  if (!r.ok) { resultsEl.innerHTML = '<div class="empty">…</div>'; return; }
  const { results } = await r.json();
  if (!results.length) { resultsEl.innerHTML = '<div class="empty">No matches.</div>'; return; }
  resultsEl.innerHTML = '';
  for (const item of results) {
    const b = document.createElement('button');
    b.className = 'result';
    b.innerHTML =
      `<span class="badge ${item.source}">${item.source}</span>` +
      `<span class="title">${esc(item.title)}</span>` +
      (item.sub ? `<div class="sub">${esc(item.sub)}</div>` : '');
    b.onclick = () => showLabel(item.source, item.id);
    resultsEl.appendChild(b);
  }
}

async function showLabel(source, id) {
  labelEl.innerHTML = '<p class="meta">loading…</p>';
  panelEl.hidden = false;
  const r = await fetch(`/api/food?source=${source}&id=${encodeURIComponent(id)}`);
  if (!r.ok) { labelEl.innerHTML = '<p class="meta">Could not load.</p>'; return; }
  labelEl.innerHTML = renderLabel(await r.json());
}

// One label row: label text (+amount) and a %DV cell.
function row(cls, label, field, n, { bold = false } = {}) {
  const v = n[field];
  const amount = v == null ? '' : ` ${fmt(v, UNIT[field])}`;
  const name = bold ? `<b>${label}</b>` : label;
  return `<tr><td class="${cls}">${name}${amount}</td><td class="dv">${dv(field, v)}</td></tr>`;
}

function renderLabel(d) {
  const n = d.n;
  const cal = n.energyKcal == null ? '—' : Math.round(n.energyKcal);
  const added = n.addedSugars == null ? '' :
    `<tr><td class="ind2">Includes ${fmt(n.addedSugars, 'g')} Added Sugars</td><td class="dv">${dv('addedSugars', n.addedSugars)}</td></tr>`;

  // Micros only render when present (USDA has them; OFF usually doesn't).
  const micros = ['vitaminD', 'calcium', 'iron', 'potassium']
    .filter((f) => n[f] != null)
    .map((f) => {
      const names = { vitaminD: 'Vitamin D', calcium: 'Calcium', iron: 'Iron', potassium: 'Potassium' };
      return `<tr><td>${names[f]} ${fmt(n[f], UNIT[f])}</td><td class="dv">${dv(f, n[f])}</td></tr>`;
    }).join('');

  return `
  <div class="nf">
    ${d.brand ? `<p class="brand">${esc(d.brand)}</p>` : ''}
    <p class="name">${esc(d.title)}</p>
    <p class="title">Nutrition Facts</p>
    <p class="serving">Serving: ${esc(d.servingText)}</p>
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
    <p class="footnote">* The % Daily Value tells you how much a nutrient in a serving contributes to a daily diet. 2,000 calories a day is used for general nutrition advice.</p>
    ${d.ingredients ? `<p class="ingredients"><b>Ingredients:</b> ${esc(d.ingredients)}</p>` : ''}
  </div>`;
}

loadStats();
