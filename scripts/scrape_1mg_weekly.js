/**
 * Incremental weekly scraper for 1mg.com medicines.
 *
 * Option A: Only scrapes NEW medicines, updates prices for existing ones.
 * Maintains .1mg_index.json to track what's been scraped.
 *
 * Run: node scripts/scrape_1mg_weekly.js
 * Cron: 0 2 * * 1 (Monday 2 AM)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { parse } = require('node-html-parser');
const { stringify } = require('csv-stringify/sync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, '1mg_medicines_weekly.csv');
const INDEX_FILE = path.join(DATA_DIR, '.1mg_index.json');
const HEADERS = ['brand_name', 'generic_name', 'dosage', 'dosage_form', 'manufacturer', 'price', 'ingredients', 'first_scraped', 'last_updated'];

const DELAY_MS = 3000;
const MAX_RETRIES = 3;

// ---- Args ----
const args = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const LIMIT = parseInt(getArg('--limit', '0'), 10); // 0 = no limit (weekly full run)

// ---- Fetch with timeout ----
function fetch(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Medicine-Scraper/1.0)' } }, (res) => {
      clearTimeout(timeout);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    }).on('error', reject);
  });
}

// ---- Load index of previously scraped medicines ----
function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

// ---- Save index ----
function saveIndex(index) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

// ---- Load existing CSV into a map ----
function loadExistingMedicines() {
  if (!fs.existsSync(OUTPUT_FILE)) {
    return {};
  }
  try {
    const csv = fs.readFileSync(OUTPUT_FILE, 'utf-8').split('\n').slice(1);
    const map = {};
    for (const line of csv) {
      if (!line.trim()) continue;
      const parts = line.split(',');
      if (parts[0]) map[parts[0]] = line;
    }
    return map;
  } catch {
    return {};
  }
}

// ---- Get medicine URLs from sitemap ----
async function getMedicineUrls() {
  console.log('Fetching sitemap.xml...');
  try {
    const xml = await fetch('https://www.1mg.com/sitemap.xml');
    const urls = xml.match(/https:\/\/www\.1mg\.com\/medicines\/[^\<]+/g) || [];
    console.log(`Found ${urls.length} medicine URLs in sitemap`);
    return LIMIT > 0 ? urls.slice(0, LIMIT) : urls;
  } catch (e) {
    console.error('Sitemap fetch failed:', e.message);
    return [];
  }
}

// ---- Scrape full medicine page (for new medicines) ----
async function scrapeMedicine(url, retries = 0) {
  try {
    const html = await fetch(url);
    const doc = parse(html);

    const brandName = doc.querySelector('h1')?.text?.trim() || '';
    const genericName = doc.querySelector('[class*="generic"]')?.text?.trim() || '';
    const dosage = doc.querySelector('[class*="dosage"]')?.text?.trim() || '';
    const form = doc.querySelector('[class*="form"]')?.text?.trim() || '';
    const manufacturer = doc.querySelector('[class*="manufacturer"]')?.text?.trim() || '';
    const price = doc.querySelector('[class*="price"]')?.text?.trim() || '';

    const ingElements = doc.querySelectorAll('[class*="ingredient"]');
    const ingredients = ingElements.map(e => e.text?.trim()).filter(Boolean).join(' | ') || '';

    const now = new Date().toISOString().split('T')[0];
    return {
      brand_name: brandName,
      generic_name: genericName,
      dosage: dosage,
      dosage_form: form,
      manufacturer: manufacturer,
      price: price,
      ingredients: ingredients,
      first_scraped: now,
      last_updated: now,
    };
  } catch (e) {
    if (retries < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, DELAY_MS * 2));
      return scrapeMedicine(url, retries + 1);
    }
    return null;
  }
}

// ---- Lightweight price check (for existing medicines) ----
async function updatePrice(url, retries = 0) {
  try {
    const html = await fetch(url);
    const doc = parse(html);
    const price = doc.querySelector('[class*="price"]')?.text?.trim() || '';
    return price;
  } catch (e) {
    if (retries < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, DELAY_MS * 2));
      return updatePrice(url, retries + 1);
    }
    return null;
  }
}

// ---- Main ----
(async () => {
  const urls = await getMedicineUrls();
  if (urls.length === 0) {
    console.error('No URLs found. Exiting.');
    process.exit(1);
  }

  const index = loadIndex();
  const existing = loadExistingMedicines();
  const now = new Date().toISOString().split('T')[0];

  const newUrls = urls.filter(url => !index[url]);
  const existingUrls = urls.filter(url => index[url]);

  console.log(`\nSummary:`);
  console.log(`  Total URLs in sitemap: ${urls.length}`);
  console.log(`  Already scraped: ${existingUrls.length}`);
  console.log(`  New to scrape: ${newUrls.length}\n`);

  const newRows = [];
  let newSuccess = 0, newFailed = 0, updatedSuccess = 0, updatedFailed = 0;
  const startTime = Date.now();

  // ---- PHASE 1: Scrape new medicines ----
  console.log(`Phase 1: Scraping ${newUrls.length} new medicines...`);
  for (let i = 0; i < newUrls.length; i++) {
    const url = newUrls[i];
    const medName = url.split('/medicines/')[1];
    process.stdout.write(`[${i + 1}/${newUrls.length}] ${medName} `);

    const medicine = await scrapeMedicine(url);
    if (medicine) {
      newRows.push(medicine);
      index[url] = now;
      newSuccess++;
      console.log('✓');
    } else {
      newFailed++;
      console.log('✗');
    }

    if (i < newUrls.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  // ---- PHASE 2: Update prices for existing medicines ----
  console.log(`\nPhase 2: Updating prices for ${existingUrls.length} existing medicines...`);
  for (let i = 0; i < existingUrls.length; i++) {
    const url = existingUrls[i];
    const medName = url.split('/medicines/')[1];
    process.stdout.write(`[${i + 1}/${existingUrls.length}] ${medName} `);

    const newPrice = await updatePrice(url);
    if (newPrice) {
      updatedSuccess++;
      console.log(`✓ (${newPrice})`);
    } else {
      updatedFailed++;
      console.log('✗');
    }

    if (i < existingUrls.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  // ---- Write results ----
  const allRows = [...Object.values(existing).map(line => {
    const parts = line.split(',');
    return {
      brand_name: parts[0],
      generic_name: parts[1],
      dosage: parts[2],
      dosage_form: parts[3],
      manufacturer: parts[4],
      price: parts[5],
      ingredients: parts[6],
      first_scraped: parts[7],
      last_updated: now,
    };
  }), ...newRows];

  const csv = stringify(allRows, { header: true, columns: HEADERS });
  fs.writeFileSync(OUTPUT_FILE, csv);
  saveIndex(index);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s`);
  console.log(`   New: ${newSuccess}/${newUrls.length} success`);
  console.log(`   Updated: ${updatedSuccess}/${existingUrls.length} success`);
  console.log(`   Index entries: ${Object.keys(index).length}`);
  console.log(`   Output: ${OUTPUT_FILE}`);
})();
