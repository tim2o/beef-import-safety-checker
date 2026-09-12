/* Beef Import Safety Checker
 * - Recall & Public Health Alert API: fetched live from FSIS on every page load
 *   (fsis.usda.gov sends CORS headers on this endpoint, confirmed working cross-origin).
 * - Import Presented/Refused + Import Refusal Reason datasets: FSIS does NOT send
 *   CORS headers on these files, so a browser on any origin but fsis.usda.gov itself
 *   can't fetch them directly. We ship a pre-processed snapshot as static JSON in
 *   ./data/ instead — see README.md for how that snapshot is generated/refreshed.
 * No backend needed to serve this site.
 */

const RECALL_API = 'https://www.fsis.usda.gov/fsis/api/recall/v/1';
// FSIS's import-refusal ZIP files don't send CORS headers, so a browser on any
// origin other than fsis.usda.gov itself can't fetch them directly (confirmed
// by testing). Instead we ship pre-processed snapshots of that same public
// data as static JSON in ./data/, regenerated periodically. See data/*.json's
// "generatedAt" field for freshness, and README.md for how to refresh them.
const DATA_URLS = {
  countryStats: 'data/country_stats.json',
  establishments: 'data/establishments.json',
  labFailures: 'data/lab_failures.json',
  // USDA's domestic Meat, Poultry & Egg Product Inspection (MPI) Directory —
  // a completely separate dataset from the import-refusal data above. This is
  // what lets us tell a user "this EST number isn't an importer at all, it's
  // a US plant in <city, state>" instead of just "nothing found."
  domesticEstablishments: 'data/domestic_establishments.json',
};

const state = {
  countryStats: [],      // [{country, presented, refused, labFail, admin}]
  establishments: [],    // [{estCode, estName, country, refusedCount, labFailCount, reasons, productGroups, lastRefusedDate, fiscalYears}]
  labFailures: [],       // individual "Failed Laboratory Analyses" refusal records
  domesticEstablishments: [], // [{codes, estName, dbas, street, city, state, zip, county, size, beefSlaughter, beefProcessing}]
  recalls: [],
  dataGeneratedAt: null,
  fiscalYearsCovered: [],
  domesticGeneratedAt: null,
  dataReady: false, // guards against searching before the USDA snapshots finish loading (see loadImportData)
};

// ---------- tabs ----------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ---------- load pre-processed USDA snapshots ----------
async function loadImportData() {
  const statusEl = document.getElementById('searchStatus');
  if (statusEl) statusEl.textContent = 'Loading USDA import-refusal snapshot…';
  try {
    // All four fetched together and awaited before anything reports "ready to
    // search" — domestic_establishments.json is the largest file (~800KB), so
    // if it were left to resolve in the background after the status message
    // already said "Search above," a search fired in that window would
    // silently find zero domestic matches even for a real establishment. That
    // exact race is why an EST number that legitimately exists in the
    // domestic directory could come back "not found."
    const [cs, est, lab, dom] = await Promise.all([
      fetch(DATA_URLS.countryStats).then(r => r.json()),
      fetch(DATA_URLS.establishments).then(r => r.json()),
      fetch(DATA_URLS.labFailures).then(r => r.json()),
      fetch(DATA_URLS.domesticEstablishments).then(r => r.json()),
    ]);
    state.countryStats = cs.countries;
    state.establishments = est.establishments;
    state.labFailures = lab.labFailures;
    state.dataGeneratedAt = new Date(cs.generatedAt);
    state.fiscalYearsCovered = cs.fiscalYears;
    state.domesticEstablishments = dom.establishments;
    state.domesticGeneratedAt = new Date(dom.generatedAt);

    state.dataReady = true;
    const totalRefused = state.countryStats.reduce((a, c) => a + c.refused, 0);
    if (statusEl) statusEl.textContent = `Loaded ${totalRefused.toLocaleString()} refused beef lots across ${state.fiscalYearsCovered.join(', ')}. Search above.`;
    renderCountryTable();
    renderLabFailList();
    const freshEl = document.getElementById('dataFreshness');
    if (freshEl) {
      freshEl.textContent = `Import refusal snapshot generated ${state.dataGeneratedAt.toLocaleString()} (fiscal years ${state.fiscalYearsCovered.join(', ')}) · domestic establishment directory generated ${state.domesticGeneratedAt.toLocaleString()}. Regenerate via scripts/refresh instructions in README.md.`;
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = `Couldn't load USDA data (${e.message}). Try reloading the page.`;
  }
}

// ---------- country risk table ----------
function renderCountryTable() {
  const wrap = document.getElementById('countryTableWrap');
  const rows = state.countryStats
    .map(s => ({ ...s, rate: s.presented ? (s.refused / s.presented) * 100 : 0 }))
    .filter(r => r.presented >= 5) // drop noise from single-lot countries
    .sort((a, b) => b.rate - a.rate);

  if (!rows.length) {
    wrap.innerHTML = '<p class="status">No data loaded yet.</p>';
    return;
  }

  const body = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.country)}</td>
      <td>${r.presented.toLocaleString()}</td>
      <td>${r.refused.toLocaleString()}</td>
      <td>${r.rate.toFixed(1)}%</td>
      <td>${r.labFail ? `<span class="badge badge-lab">${r.labFail} lab-analysis</span>` : '—'}</td>
      <td>${r.admin ? `<span class="badge badge-admin">${r.admin} admin/physical</span>` : '—'}</td>
    </tr>`).join('');

  wrap.innerHTML = `
    <div class="overflow">
    <table>
      <thead><tr>
        <th>Country</th><th>Presented</th><th>Refused</th><th>Refusal rate</th>
        <th>Failed lab analyses</th><th>Admin / physical refusals</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
    </div>
    <p class="hint">"Failed lab analyses" covers both pathogen findings and chemical/drug residue findings (including compounds like chloramphenicol) — USDA's public data does not separate these two. Everything else ("admin/physical") is paperwork, labeling, or shipping-damage refusals, not a safety finding.</p>
  `;
}

function renderLabFailList() {
  const list = document.getElementById('labFailList');
  const labLots = state.labFailures;
  if (!labLots.length) {
    list.innerHTML = '<li>No beef lots were refused for "Failed Laboratory Analyses" in the currently loaded fiscal years.</li>';
    return;
  }
  list.innerHTML = labLots.slice(0, 100).map(r => `
    <li>
      <strong>${escapeHtml(r.country)}</strong> — ${escapeHtml(r.estName || 'unknown establishment')}
      (EST ${escapeHtml(r.estCode || '?')}), refused ${escapeHtml(r.refusedDate)},
      product: ${escapeHtml(r.productCategory || 'beef')}
      ${(r.details || []).map(d => `<span class="pill">${escapeHtml(d)}</span>`).join('')}
    </li>`).join('') +
    (labLots.length > 100 ? `<li class="status">…and ${labLots.length - 100} more. Use the search tab and filter by country or establishment.</li>` : '');
}

// ---------- product/establishment/country search ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function findMatches(q) {
  q = q.trim().toLowerCase();
  if (!q) return { importMatches: [], recallMatches: [], domesticMatches: [] };
  const importMatches = state.establishments.filter(r =>
    (r.country || '').toLowerCase().includes(q) ||
    (r.estCode || '').toLowerCase() === q ||
    (r.estName || '').toLowerCase().includes(q) ||
    (r.productGroups || []).some(p => (p || '').toLowerCase().includes(q))
  );

  // USDA's domestic MPI directory — a completely separate dataset from the
  // import-refusal data above. This is what lets a plant that's never
  // imported anything (or a US-based one entirely) still turn up, so a "not
  // found in import data" result can become "this is a US plant in Iowa"
  // instead of silence.
  const domesticMatches = state.domesticEstablishments.filter(r =>
    (r.codes || []).some(c => c.toLowerCase() === q) ||
    (r.estName || '').toLowerCase().includes(q) ||
    (r.dbas || '').toLowerCase().includes(q) ||
    (r.city || '').toLowerCase().includes(q) ||
    (r.state || '').toLowerCase() === q
  );

  // Recalls (FSIS's live feed) don't carry establishment NUMBERS at all —
  // field_establishment holds company names as free text. A raw EST number
  // like "93" matched against recall title/summary as a plain substring
  // false-positives constantly (phone numbers, UPC codes, package weights all
  // contain stray digits). So for a purely-numeric EST query, resolve it to
  // the establishment's actual name(s) via our own data first, and match
  // recalls against those names instead of against the bare number.
  const isEstCode = /^\d{1,6}[a-z]?$/.test(q);
  let recallMatches;
  if (isEstCode) {
    const names = new Set([
      ...importMatches.filter(r => r.estCode.toLowerCase() === q).map(r => r.estName.toLowerCase()),
      ...domesticMatches.map(r => r.estName.toLowerCase()),
    ]);
    recallMatches = names.size
      ? state.recalls.filter(r =>
          [...names].some(name =>
            (r.field_title || '').toLowerCase().includes(name) ||
            (r.field_establishment || []).some(e => (e || '').toLowerCase().includes(name) || name.includes((e || '').toLowerCase()))
          ))
      : [];
  } else {
    recallMatches = state.recalls.filter(r =>
      (r.field_title || '').toLowerCase().includes(q) ||
      (r.field_summary || '').toLowerCase().includes(q) ||
      (r.field_establishment || []).some(e => (e || '').toLowerCase().includes(q))
    );
  }
  return { importMatches, recallMatches, domesticMatches };
}

function renderMatchesHtml(importMatches, recallMatches, domesticMatches = []) {
  let html = '';

  if (importMatches.length) {
    const sorted = [...importMatches].sort((a, b) => b.refusedCount - a.refusedCount);
    html += `<h3>Establishments &amp; countries in USDA import records</h3>
    <p class="hint">Every plant below has actually shipped beef to the US and passed through FSIS port
    reinspection in FY2025–FY2026. A "0 refused" row is a genuinely good sign for that specific plant — it
    just isn't proof of anything about a specific package, since FSIS samples shipments rather than testing every one.</p>
    <div class="overflow"><table>
      <thead><tr><th>Country</th><th>Establishment</th><th>Status</th><th>Presented</th><th>Last activity</th><th>Products</th><th>Reasons on file</th></tr></thead>
      <tbody>${sorted.slice(0, 200).map(r => {
        const clean = r.refusedCount === 0;
        const statusBadge = clean
          ? '<span class="badge badge-ok">0 refused</span>'
          : `<span class="badge badge-admin">${r.refusedCount} refused</span>${r.labFailCount ? ` <span class="badge badge-lab">${r.labFailCount} lab-analysis</span>` : ''}`;
        return `
        <tr>
          <td>${escapeHtml(r.country)}</td>
          <td>${escapeHtml(r.estName)} (EST ${escapeHtml(r.estCode)})</td>
          <td>${statusBadge}</td>
          <td>${r.presentedCount ?? '—'}</td>
          <td>${escapeHtml(r.lastRefusedDate || r.lastPresentedDate || '')}</td>
          <td>${(r.productGroups || []).map(escapeHtml).join(', ')}</td>
          <td>${clean ? '—' : (r.reasons || []).map(x => `<span class="pill">${escapeHtml(x)}</span>`).join('')}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
    if (importMatches.length > 200) html += `<p class="status">Showing first 200 of ${importMatches.length} matches.</p>`;
  }

  if (recallMatches.length) {
    html += `<h3>Recalls</h3>` + recallMatches.slice(0, 50).map(recallCardHtml).join('');
  }

  if (domesticMatches.length) {
    html += `<h3>🇺🇸 Domestic (non-import) US establishments</h3>
    <p class="hint">These plants are from USDA's <strong>domestic</strong> inspection directory — a completely
    separate dataset from the import-refusal records above. A match here means the establishment is a
    US-based plant, not an importer, so this beef (or at least this specific processing step) was not
    imported. This directory doesn't carry refusal/recall history the way the import data does — it's a
    "where is this plant" lookup, not a safety record.</p>
    <div class="overflow"><table>
      <thead><tr><th>Establishment</th><th>Location</th><th>Size</th><th>Beef activity</th></tr></thead>
      <tbody>${domesticMatches.slice(0, 200).map(r => `
        <tr>
          <td>${escapeHtml(r.estName)}${r.dbas ? ` <span class="hint">(dba ${escapeHtml(r.dbas)})</span>` : ''} (EST ${escapeHtml((r.codes || []).join('/'))})</td>
          <td>${escapeHtml(r.city)}, ${escapeHtml(r.state)} ${escapeHtml(r.zip)} — ${escapeHtml(r.county || '')}</td>
          <td>${escapeHtml(r.size || '—')}</td>
          <td>${[r.beefSlaughter && 'Slaughter', r.beefProcessing && 'Processing'].filter(Boolean).map(x => `<span class="pill">${x}</span>`).join('') || '—'}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
    if (domesticMatches.length > 200) html += `<p class="status">Showing first 200 of ${domesticMatches.length} matches.</p>`;
  }

  if (!importMatches.length && !recallMatches.length && !domesticMatches.length) {
    html = '<p class="card">Nothing on file for that search — no establishment (imported or domestic), country, or recall matched it in USDA\'s published data. That could mean the establishment/country name didn\'t match what we have on record, or it\'s a real gap in what USDA publishes. It is not confirmation of safety either way.</p>';
  }
  return html;
}

// USDA data loads asynchronously (see loadImportData); searching before it's
// ready would silently return false "not found" results rather than an
// honest "still loading." Every search entry point checks this first.
function notReadyMessage() {
  return 'Still loading USDA data — give it a moment and search again. (Searching before this finishes can make a real establishment look like it\'s "not found.")';
}

function runSearch() {
  const q = document.getElementById('searchInput').value;
  const resultsEl = document.getElementById('searchResults');
  const statusEl = document.getElementById('searchStatus');
  if (!q.trim()) { resultsEl.innerHTML = ''; return; }
  if (!state.dataReady) { statusEl.textContent = notReadyMessage(); resultsEl.innerHTML = ''; return; }
  const { importMatches, recallMatches, domesticMatches } = findMatches(q);
  statusEl.textContent = `${importMatches.length} border-refusal record(s), ${domesticMatches.length} domestic establishment(s), ${recallMatches.length} recall(s) matched "${q.trim()}".`;
  resultsEl.innerHTML = renderMatchesHtml(importMatches, recallMatches, domesticMatches);
}

document.getElementById('searchBtn').addEventListener('click', runSearch);
document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

// ---------- recalls ----------
function recallCardHtml(r) {
  const risk = r.field_risk_level || '';
  const badgeClass = /class i\b/i.test(risk) ? 'badge-lab' : (/class ii/i.test(risk) ? 'badge-admin' : 'badge-ok');
  return `<div class="card">
    <strong>${escapeHtml(r.field_title)}</strong>
    <span class="badge ${badgeClass}">${escapeHtml(risk)}</span>
    <p class="hint">Date: ${escapeHtml(r.field_recall_date)} · Reason: ${(r.field_recall_reason || []).map(escapeHtml).join(', ')}</p>
    ${r.field_recall_url ? `<p><a href="${escapeHtml(r.field_recall_url)}" target="_blank" rel="noopener">View full recall notice ↗</a></p>` : ''}
  </div>`;
}

async function loadRecalls() {
  const resultsEl = document.getElementById('recallResults');
  try {
    const res = await fetch(RECALL_API, { mode: 'cors' });
    const data = await res.json();
    state.recalls = data
      .filter(r => /beef|bovine/i.test(JSON.stringify([r.field_title, r.field_product_items, r.field_summary])))
      .sort((a, b) => (b.field_recall_date || '').localeCompare(a.field_recall_date || ''));
    renderRecalls(state.recalls);
  } catch (e) {
    console.error(e);
    resultsEl.innerHTML = `<p class="status">Couldn't load live recall feed (${e.message}).</p>`;
  }
}

function renderRecalls(list) {
  const resultsEl = document.getElementById('recallResults');
  if (!list.length) { resultsEl.innerHTML = '<p class="status">No beef recalls matched.</p>'; return; }
  resultsEl.innerHTML = `<p class="hint">${list.length} beef-related recall(s)/alerts found in FSIS's live feed.</p>` +
    list.slice(0, 100).map(recallCardHtml).join('');
}

document.getElementById('recallSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) { renderRecalls(state.recalls); return; }
  renderRecalls(state.recalls.filter(r => JSON.stringify(r).toLowerCase().includes(q)));
});

// ---------- photo scan (client-side OCR, nothing uploaded anywhere) ----------
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let tesseractLoadPromise = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (tesseractLoadPromise) return tesseractLoadPromise;
  tesseractLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the OCR engine (check your connection).'));
    document.head.appendChild(s);
  });
  return tesseractLoadPromise;
}

function knownCountryNames() {
  const names = new Set(state.countryStats.map(c => c.country));
  names.add('UNITED STATES');
  return [...names];
}

function extractSignals(text) {
  const upper = text.toUpperCase();

  const countries = knownCountryNames().filter(c => upper.includes(c));

  const estNumbers = new Set();
  const estRegex = /\bEST\.?\s*(?:NO\.?|#|:)?\s*(\d{1,6}[A-Z]?)\b/gi;
  let m;
  while ((m = estRegex.exec(text)) !== null) estNumbers.add(m[1]);

  // fuzzy brand match: does any significant word of a known establishment name
  // appear in the OCR text? Excludes generic corporate words and country names
  // (a country name inside a company's legal name, e.g. "...Canada, Inc.",
  // isn't a brand signal — it's already covered by the country-mention check).
  const GENERIC_WORDS = new Set(['BEEF','MEAT','MEATS','FOODS','FOOD','INTERNATIONAL','COMPANY','CORP',
    'CORPORATION','INC','LLC','LTD','LIMITED','LIMITEE','INDUSTRIES','GROUP','PACKING','PROCESSING']);
  const countryWords = new Set(knownCountryNames().flatMap(c => c.split(/\s+/)));
  const brandMatches = new Map(); // estKey -> establishment record
  for (const est of state.establishments) {
    const estWords = (est.estName || '').toUpperCase().split(/[^A-Z0-9]+/)
      .filter(w => w.length >= 4 && !GENERIC_WORDS.has(w) && !countryWords.has(w));
    if (estWords.some(w => upper.includes(w))) {
      brandMatches.set(`${est.estCode}|${est.country}`, est);
    }
  }

  return { countries, estNumbers: [...estNumbers], brandMatches: [...brandMatches.values()].slice(0, 10) };
}

function renderScanSignals(signals) {
  const el = document.getElementById('scanSignals');
  const parts = [];

  if (signals.estNumbers.length) {
    parts.push(`<div class="signal-group"><h4>EST. numbers found</h4>${signals.estNumbers.map(n =>
      `<button class="pill pill-btn" data-scan-query="${escapeHtml(n)}">EST ${escapeHtml(n)}</button>`).join(' ')}</div>`);
  }
  if (signals.countries.length) {
    parts.push(`<div class="signal-group"><h4>Country mentioned on label</h4>${signals.countries.map(c =>
      `<button class="pill pill-btn" data-scan-query="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join(' ')}</div>`);
  }
  if (signals.brandMatches.length) {
    parts.push(`<div class="signal-group"><h4>Possible plant/brand match in our refusal data</h4>${signals.brandMatches.map(b =>
      `<button class="pill pill-btn" data-scan-query="${escapeHtml(b.estCode)}">${escapeHtml(b.estName)} (EST ${escapeHtml(b.estCode)}, ${escapeHtml(b.country)})</button>`).join(' ')}</div>`);
  }
  if (!parts.length) {
    parts.push('<p class="status">No EST number, known country name, or matching brand was found in the extracted text. Try the back label (nutrition facts panel) or a clearer, closer photo — see the raw text below to check what OCR actually read.</p>');
  }
  el.innerHTML = parts.join('');

  el.querySelectorAll('[data-scan-query]').forEach(btn => {
    btn.addEventListener('click', () => runScanQuery(btn.dataset.scanQuery));
  });

  // Small stamped/embossed EST marks are the single hardest thing for OCR to
  // read correctly (letter/digit confusion like T<->1 is common) — always
  // offer a manual-correction box pre-filled with our best guess, since the
  // regex/matching logic can only ever be as good as what Tesseract handed it.
  const correctWrap = document.getElementById('scanCorrectWrap');
  const correctInput = document.getElementById('scanCorrectInput');
  correctWrap.hidden = false;
  correctInput.value = signals.estNumbers[0] || signals.countries[0] || '';

  // auto-run the strongest signal: an EST number beats a country name
  if (signals.estNumbers.length) runScanQuery(signals.estNumbers[0]);
  else if (signals.countries.length) runScanQuery(signals.countries[0]);
}

function runScanQuery(q) {
  const resultsEl = document.getElementById('scanResults');
  if (!state.dataReady) { resultsEl.innerHTML = `<p class="status">${notReadyMessage()}</p>`; return; }
  const { importMatches, recallMatches, domesticMatches } = findMatches(q);
  resultsEl.innerHTML = `<h3>Results for "${escapeHtml(q)}"</h3>` + renderMatchesHtml(importMatches, recallMatches, domesticMatches);
}

document.getElementById('scanCorrectBtn').addEventListener('click', () => {
  const q = document.getElementById('scanCorrectInput').value;
  if (q.trim()) runScanQuery(q);
});
document.getElementById('scanCorrectInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) runScanQuery(e.target.value);
});

document.getElementById('photoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const previewWrap = document.getElementById('scanPreviewWrap');
  const statusEl = document.getElementById('scanStatus');
  const signalsEl = document.getElementById('scanSignals');
  const rawWrap = document.getElementById('scanRawWrap');
  const resultsEl = document.getElementById('scanResults');
  const correctWrap = document.getElementById('scanCorrectWrap');
  signalsEl.innerHTML = '';
  resultsEl.innerHTML = '';
  rawWrap.hidden = true;
  correctWrap.hidden = true;
  document.getElementById('scanCorrectInput').value = '';

  const url = URL.createObjectURL(file);
  previewWrap.innerHTML = `<img src="${url}" alt="Package photo preview">`;

  try {
    statusEl.textContent = 'Loading OCR engine…';
    await loadTesseract();

    statusEl.innerHTML = '<progress id="scanProgress" value="0" max="1"></progress> Reading label…';
    const progressEl = document.getElementById('scanProgress');

    const result = await Tesseract.recognize(file, 'eng', {
      logger: (msg) => {
        if (msg.status === 'recognizing text' && progressEl) {
          progressEl.value = msg.progress;
        }
      },
    });

    const text = result.data.text || '';
    document.getElementById('scanRawText').textContent = text.trim() || '(no text detected)';
    rawWrap.hidden = false;

    if (!text.trim()) {
      statusEl.textContent = "Couldn't read any text from that photo. Try a closer, better-lit shot of the label.";
      return;
    }

    const signals = extractSignals(text);
    statusEl.textContent = 'Scan complete.';
    renderScanSignals(signals);
  } catch (err) {
    console.error(err);
    statusEl.textContent = `OCR failed: ${err.message}`;
  }
});

// ---------- boot ----------
loadRecalls();
loadImportData();
