#!/usr/bin/env node
/**
 * Regenerates data/*.json from USDA FSIS's public datasets.
 *
 * Why this needs a real browser: FSIS's site sits behind Akamai bot
 * management that returns 403 to plain HTTP clients (curl, Node fetch,
 * Python requests) even with a spoofed browser User-Agent — confirmed by
 * direct testing, not assumed. It does NOT block real browser engines, so
 * this script drives headless Chromium via Playwright, navigates to a page
 * on fsis.usda.gov (making in-page fetch() calls same-origin), and runs the
 * exact same client-side ETL logic that was originally run by hand in a
 * browser session to produce the first version of these files.
 *
 * The import-refusal ZIP files and the domestic MPI/demographic CSVs also
 * don't send CORS headers, so this same-origin trick is required regardless
 * of headless vs. headed — a plain server-side fetch cannot reach them from
 * any other origin, browser or not.
 *
 * Usage: node scripts/refresh-data.mjs
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
const PAPAPARSE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js';
const IMPORT_DATA_PAGE = 'https://www.fsis.usda.gov/inspection/import-export/international-reports/import-and-export-data';
const MPI_DIRECTORY_PAGE = 'https://www.fsis.usda.gov/inspection/establishments/meat-poultry-and-egg-product-inspection-directory';

function currentFiscalYears() {
  // FSIS's fiscal year runs Oct 1 - Sep 30. Grab the current one and the
  // prior full year, same as the original manual snapshot.
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const year = now.getUTCFullYear();
  const currentFY = month >= 10 ? year + 1 : year;
  return [`FY${currentFY}`, `FY${currentFY - 1}`];
}

async function withPage(url, fn) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.addScriptTag({ url: JSZIP_URL });
    await page.addScriptTag({ url: PAPAPARSE_URL });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function fetchImportData(fiscalYears) {
  return withPage(IMPORT_DATA_PAGE, (page) =>
    page.evaluate(async (FISCAL_YEARS) => {
      const LAB_REASON = 'Failed Laboratory Analyses';
      const estIndex = new Map();
      const countryStats = new Map();
      const labFails = [];

      function bump(map, key, field) {
        if (!map.has(key)) map.set(key, { presented: 0, refused: 0, labFail: 0, admin: 0 });
        map.get(key)[field]++;
      }
      function parseCsvRows(text, onRow) {
        return new Promise((resolve) => {
          Papa.parse(text, { header: true, skipEmptyLines: true, step: (r) => onRow(r.data), complete: resolve });
        });
      }

      for (const fy of FISCAL_YEARS) {
        const res = await fetch(
          `https://www.fsis.usda.gov/sites/default/files/media_file/documents/FSIS_import_presented_refused_and_refusal_reason_${fy}.zip`
        );
        if (!res.ok) throw new Error(`${fy} zip fetch failed: ${res.status}`);
        const buf = await res.arrayBuffer();
        const zip = await JSZip.loadAsync(buf);
        const presentedName = Object.keys(zip.files).find((n) => n.includes('presented_refused'));
        const reasonName = Object.keys(zip.files).find((n) => n.includes('refusal_reason'));

        const reasonsByLot = new Map();
        const reasonCsv = await zip.file(reasonName).async('string');
        await parseCsvRows(reasonCsv, (row) => {
          if (!row.lot_id) return;
          if (!reasonsByLot.has(row.lot_id)) reasonsByLot.set(row.lot_id, []);
          reasonsByLot.get(row.lot_id).push({ reason: row.refusal_reason, description: row.defect_description });
        });

        const presentedCsv = await zip.file(presentedName).async('string');
        await parseCsvRows(presentedCsv, (row) => {
          if (row.species !== 'Beef') return;
          const country = (row.country || 'UNKNOWN').trim();
          bump(countryStats, country, 'presented');
          const estKey = `${row.processing_establishment}|${country}`;
          if (!estIndex.has(estKey)) {
            estIndex.set(estKey, {
              estCode: row.processing_establishment,
              estName: row.processing_est_name,
              country,
              presentedCount: 0,
              refusedCount: 0,
              labFailCount: 0,
              reasons: new Set(),
              productGroups: new Set(),
              haccpCodes: new Set(),
              lastRefusedDate: '',
              lastPresentedDate: '',
              fiscalYears: new Set(),
            });
          }
          const e = estIndex.get(estKey);
          e.presentedCount++;
          if (row.product_category) e.productGroups.add(row.product_category);
          if (row.haccp_code) e.haccpCodes.add(row.haccp_code);
          if (row.received_lot_date > e.lastPresentedDate) e.lastPresentedDate = row.received_lot_date;
          e.fiscalYears.add(fy);

          const isRefused = row.refused_date && row.refused_date !== 'NULL';
          if (isRefused) {
            const reasons = reasonsByLot.get(row.lot_id) || [];
            const hasLabFail = reasons.some((r) => r.reason === LAB_REASON);
            bump(countryStats, country, 'refused');
            bump(countryStats, country, hasLabFail ? 'labFail' : 'admin');
            e.refusedCount++;
            if (hasLabFail) e.labFailCount++;
            reasons.forEach((r) => e.reasons.add(r.description || r.reason));
            if (row.refused_date > e.lastRefusedDate) e.lastRefusedDate = row.refused_date;
            if (hasLabFail) {
              labFails.push({
                fiscalYear: fy,
                country,
                estCode: row.processing_establishment,
                estName: row.processing_est_name,
                importHouse: row.import_house_name,
                productCategory: row.product_category,
                refusedDate: row.refused_date,
                details: reasons.map((r) => r.description || r.reason),
              });
            }
          }
        });
      }

      const countryStatsOut = [...countryStats.entries()].map(([country, s]) => ({ country, ...s }));
      const estIndexOut = [...estIndex.values()].map((e) => ({
        ...e,
        reasons: [...e.reasons],
        productGroups: [...e.productGroups],
        haccpCodes: [...e.haccpCodes],
        fiscalYears: [...e.fiscalYears],
      }));

      return { generatedAt: new Date().toISOString(), fiscalYears: FISCAL_YEARS, countryStatsOut, estIndexOut, labFails };
    }, fiscalYears)
  );
}

async function fetchDomesticData() {
  return withPage(MPI_DIRECTORY_PAGE, (page) =>
    page.evaluate(async () => {
      function parseCsvRows(text) {
        return Papa.parse(text, { header: true, skipEmptyLines: true }).data;
      }

      const [mpiRes, demoRes] = await Promise.all([
        fetch('https://www.fsis.usda.gov/sites/default/files/media_file/documents/MPI_Directory_by_Establishment_Number.csv'),
        fetch('https://www.fsis.usda.gov/sites/default/files/media_file/documents/Dataset_Establishment_Demographic_Data.csv'),
      ]);
      if (!mpiRes.ok) throw new Error(`MPI directory fetch failed: ${mpiRes.status}`);
      if (!demoRes.ok) throw new Error(`Demographic data fetch failed: ${demoRes.status}`);

      const mpiRows = parseCsvRows(await mpiRes.text());
      const demoRows = parseCsvRows(await demoRes.text());
      const mpiByNum = new Map(mpiRows.map((r) => [r.establishment_number, r]));

      const beefCols = Object.keys(demoRows[0]).filter((k) => k.includes('beef'));
      const isBeefRow = (r) => beefCols.some((c) => r[c] === 'Yes');
      const normalizeCodes = (compound) =>
        [...new Set(compound.split('+').map((tok) => tok.replace(/^[A-Z]+/, '')).filter(Boolean))];

      const establishments = [];
      for (const d of demoRows) {
        if (!isBeefRow(d)) continue;
        const m = mpiByNum.get(d.establishment_number);
        if (!m) continue;
        establishments.push({
          codes: normalizeCodes(d.establishment_number),
          estName: m.establishment_name,
          dbas: m.dbas || '',
          street: (m.street || '').trim(),
          city: m.city,
          state: m.state,
          zip: m.zip,
          county: m.county,
          size: m.size,
          beefSlaughter: ['beef_cow_slaughter', 'steer_slaughter', 'heifer_slaughter', 'bull_stag_slaughter'].some(
            (c) => d[c] === 'Yes'
          ),
          beefProcessing: [
            'beef_processing',
            'rte_beef_processing',
            'nrte_beef_processing',
            'raw_intact_beef_processing',
            'raw_non_intact_beef_processing',
          ].some((c) => d[c] === 'Yes'),
        });
      }

      return { generatedAt: new Date().toISOString(), establishments };
    })
  );
}

async function main() {
  const fiscalYears = currentFiscalYears();
  console.log(`Refreshing USDA snapshots for fiscal years: ${fiscalYears.join(', ')}`);

  console.log('Fetching import presented/refused data...');
  const importData = await fetchImportData(fiscalYears);
  console.log(
    `  ${importData.countryStatsOut.length} countries, ${importData.estIndexOut.length} establishments, ${importData.labFails.length} lab-analysis failures`
  );

  console.log('Fetching domestic MPI directory...');
  const domesticData = await fetchDomesticData();
  console.log(`  ${domesticData.establishments.length} domestic beef establishments`);

  await writeFile(
    path.join(DATA_DIR, 'country_stats.json'),
    JSON.stringify({ generatedAt: importData.generatedAt, fiscalYears: importData.fiscalYears, countries: importData.countryStatsOut })
  );
  await writeFile(
    path.join(DATA_DIR, 'establishments.json'),
    JSON.stringify({ generatedAt: importData.generatedAt, fiscalYears: importData.fiscalYears, establishments: importData.estIndexOut })
  );
  await writeFile(
    path.join(DATA_DIR, 'lab_failures.json'),
    JSON.stringify({ generatedAt: importData.generatedAt, fiscalYears: importData.fiscalYears, labFailures: importData.labFails })
  );
  await writeFile(
    path.join(DATA_DIR, 'domestic_establishments.json'),
    JSON.stringify({ generatedAt: domesticData.generatedAt, establishments: domesticData.establishments })
  );

  console.log('Done. data/*.json refreshed.');
}

main().catch((err) => {
  console.error('Refresh failed:', err);
  process.exit(1);
});
