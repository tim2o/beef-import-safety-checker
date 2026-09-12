# Beef Import Safety Checker

A static website (no backend required) for checking imported beef against two
real USDA Food Safety and Inspection Service (FSIS) public data sources:

1. **FSIS Recall & Public Health Alert API** — fetched live, client-side, on
   every page load. `https://www.fsis.usda.gov/fsis/api/recall/v/1`
2. **FSIS Import Presented/Refused & Import Refusal Reason datasets** — lot-level
   records of every meat shipment refused entry at a US port. Published monthly
   by USDA as ZIP/CSV files.
3. **FSIS Meat, Poultry & Egg Product Inspection (MPI) Directory** — USDA's
   *domestic* establishment directory (`MPI_Directory_by_Establishment_Number.csv`)
   joined with the `Dataset_Establishment_Demographic_Data.csv` supplement (which
   flags what each plant actually slaughters/processes, beef included). This is
   a completely separate system from the import data — it's what lets the site
   say "this isn't an importer, it's a US plant in Springfield, IL" instead of
   just finding nothing. Updated weekly by USDA; the site's copy is a snapshot
   (see `data/domestic_establishments.json`'s `generatedAt`).

It also has a **"Scan a Package" photo reader**: take or upload a photo of a
label, and [Tesseract.js](https://github.com/naptha/tesseract.js) (loaded from
jsDelivr, run entirely client-side — no photo ever leaves the browser) extracts
the text, which is then regex/fuzzy-matched against the country list, EST
numbers, and establishment names in the two data sources above. It's pattern
matching on OCR output, not image recognition of the product itself — see the
in-app disclaimers (`index.html`, "What This Is" tab) for its real limits.

## Why there's a `data/` folder instead of fetching #2 live

FSIS's Recall API sends `Access-Control-Allow-Origin` headers, so any website
can fetch it directly from the browser. The import-refusal ZIP files do **not**
send CORS headers — only a page actually hosted on fsis.usda.gov can fetch them
directly; every other origin (including this site, wherever you deploy it) gets
blocked by the browser's CORS policy. This was confirmed by testing, not assumed.

FSIS's own site is also behind Akamai bot-detection that blocks plain HTTP
clients (`curl`, Python `requests`, etc.) with a 403, even with browser-like
headers — so a normal server-side cron job can't fetch it either. Only a real
browser session gets through.

**Workaround used here:** the data in `data/*.json` is a pre-processed snapshot
(country-level stats, an establishment index, and every "Failed Laboratory
Analyses" refusal record) built by fetching and parsing the official ZIPs from
inside a real browser session, then exporting the result as compact JSON. Each
file's `generatedAt` field records when it was built. The site displays this
timestamp in the "What This Is" tab so it's never presented as live.

### Refreshing the snapshot — this is a manual, on-request process

Two automated paths were tried and both hit real, confirmed dead ends —
documented here so nobody re-attempts them expecting a different result:

- **GitHub Actions** (`scripts/refresh-data.mjs` run via a scheduled workflow):
  fails with a `403` on the ZIP fetch even through headless Chromium. GitHub's
  shared-runner IP ranges are evidently on Akamai's bot-management blocklist —
  this isn't a fingerprint/engine issue (real Chromium was used), it's IP
  reputation. Deliberately routing around that (proxies, IP rotation, etc.)
  would cross from "automating access to public data" into "evading a
  government site's security controls," which isn't something to build.
- **Scheduled Claude Code cloud routines**: fail even earlier — the cloud
  sandbox's own egress proxy rejects the CONNECT tunnel to `fsis.usda.gov`
  outright (before the request ever reaches FSIS/Akamai), for curl and for
  headless Chromium alike. This is Anthropic's own sandbox network policy not
  allowlisting that host, not something refresh-data.mjs or any client library
  can work around.

So for now, refreshing `data/*.json` is a deliberate, occasional action:

**Easiest — ask a Claude Code session with Browser tool access to redo it.**
That's how the current snapshot was produced, and it's the only method
confirmed to actually reach fsis.usda.gov reliably (a real interactive browser
session, not a datacenter-hosted automation). Just ask it to refresh the USDA
data per the steps below.

**Alternative — run `scripts/refresh-data.mjs` locally,** if you have Node.js
and a working Playwright install on your own machine:

```bash
npm install
npx playwright install --with-deps chromium
npm run refresh-data
```

This has NOT been confirmed to work — it was never actually run successfully,
since testing surfaced the GitHub Actions and cloud-sandbox failures above
before a local Node environment was available to try it here. A home/office
IP is far less likely to be on a datacenter blocklist than GitHub's or a cloud
provider's ranges, so it may well work, but treat it as untested until you've
actually run it once and watched `data/*.json` change.

### Manual refresh steps (what "ask Claude to redo it" actually does)

1. Open a real browser (not curl/requests) to `https://www.fsis.usda.gov/inspection/import-export/international-reports/import-and-export-data`
   so requests are same-origin.
2. In that page's console, `fetch()` each fiscal year's ZIP
   (`FSIS_import_presented_refused_and_refusal_reason_FY20XX.zip`), unzip with
   JSZip, and parse the two CSVs inside with PapaParse.
3. For each row where `species === "Beef"`, tally:
   - `country_stats.json`: per-country counts of `presented`, `refused`,
     `labFail` (refusal reason `"Failed Laboratory Analyses"`), `admin` (every
     other reason).
   - `establishments.json`: per `(processing_establishment, country)` — built
     from every presented beef row, not just refused ones, so a plant with a
     clean record still shows up (with `refusedCount: 0`) instead of being
     invisible. Tracks `presentedCount`, `refusedCount`, `labFailCount`,
     distinct reasons/products/HACCP codes, and last-activity dates.
   - `lab_failures.json`: the individual lot records specifically refused for
     `"Failed Laboratory Analyses"` — the closest public proxy to a chemical or
     drug-residue finding (which includes, but isn't limited to, banned
     antibiotics like chloramphenicol; USDA does not publish the specific
     compound per shipment).
4. Separately, fetch `MPI_Directory_by_Establishment_Number.csv` and
   `Dataset_Establishment_Demographic_Data.csv` from
   `https://www.fsis.usda.gov/inspection/establishments/meat-poultry-and-egg-product-inspection-directory`,
   join on `establishment_number`, filter to rows with any `*beef*` column
   `=== "Yes"`, and write `domestic_establishments.json`.
5. Replace the files in `data/`, commit, and push — GitHub Pages rebuilds
   automatically.

## What this tool is not

- Not a lab test of any specific package of meat.
- Not proof that a "Failed Laboratory Analyses" refusal was chloramphenicol
  specifically — USDA's public data only gives the category, not the compound.
  For historical chloramphenicol/residue rates by country, see FSIS's National
  Residue Program annual reports: https://www.fsis.usda.gov/policy/fsis-directives/10800.1
- Not a verifier of "Product of USA" label claims — the USDA establishment (EST)
  number on a package identifies the domestic plant that last processed/packed
  it, not necessarily the country the animal came from.

## Running locally

No build step. Serve the directory with any static file server, e.g.:

```bash
python3 -m http.server 8743
```

Then open `http://localhost:8743`.
