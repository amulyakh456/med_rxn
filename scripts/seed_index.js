/**
 * One-time seed script:
 * 1. Fetches all sub-sitemaps from 1mg to get current medicine URLs
 * 2. Saves them to .1mg_index.json (marks all as "seen" so scraper skips them)
 * 3. Compares against existing Oct 2025 dataset to show 7-month gap
 *
 * Run once before starting weekly scrapes:
 *   node scripts/seed_index.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { parse } = require('csv-parse/sync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const INDEX_FILE = path.join(DATA_DIR, '.1mg_index.json');
const EXISTING_CSV = path.join(DATA_DIR, '1mg_medicines_normalized.csv');
const DELAY_MS = 1000; // 1s between sub-sitemap fetches (they're just XML, fast)

// ---- Fetch with timeout ----
function fetch(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout')), 15000);
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

// ---- Fetch sitemap index → get list of sub-sitemap URLs ----
async function getSubSitemaps() {
  const xml = await fetch('https://www.1mg.com/sitemap.xml');
  const urls = xml.match(/https:\/\/www\.1mg\.com\/sitemap_drugs_\d+\.xml/g) || [];
  return [...new Set(urls)];
}

// ---- Fetch one sub-sitemap → extract medicine URLs ----
async function getMedicineUrlsFromSubSitemap(url) {
  const xml = await fetch(url);
  const urls = xml.match(/https:\/\/www\.1mg\.com\/drugs\/[^\<]+/g) || [];
  return urls.map(u => u.trim());
}

// ---- Load existing dataset brand names ----
function loadExistingDataset() {
  if (!fs.existsSync(EXISTING_CSV)) {
    console.warn(`Warning: ${EXISTING_CSV} not found`);
    return new Set();
  }
  const raw = fs.readFileSync(EXISTING_CSV);
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  return new Set(rows.map(r => r.brand_name?.toLowerCase().trim()).filter(Boolean));
}

// ---- Main ----
(async () => {
  const today = new Date().toISOString().split('T')[0];

  console.log('Step 1: Fetching sitemap index...');
  const subSitemaps = await getSubSitemaps();
  console.log(`  Found ${subSitemaps.length} sub-sitemaps\n`);

  console.log('Step 2: Fetching all sub-sitemaps to collect medicine URLs...');
  const allUrls = new Set();

  for (let i = 0; i < subSitemaps.length; i++) {
    const sitemapUrl = subSitemaps[i];
    process.stdout.write(`  [${i + 1}/${subSitemaps.length}] ${sitemapUrl.split('/').pop()} `);
    try {
      const urls = await getMedicineUrlsFromSubSitemap(sitemapUrl);
      urls.forEach(u => allUrls.add(u));
      console.log(`→ ${urls.length} medicines (running total: ${allUrls.size})`);
    } catch (e) {
      console.log(`✗ ${e.message}`);
    }
    if (i < subSitemaps.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\nStep 3: Comparing against Oct 2025 dataset...`);
  const existingBrands = loadExistingDataset();
  console.log(`  Oct 2025 dataset: ${existingBrands.size} medicines`);
  console.log(`  1mg today (${today}): ${allUrls.size} medicines`);

  // Extract brand names from current URLs to compare
  // URL format: /drugs/brand-name-dosage-form-ID
  // We strip the trailing numeric ID to get the slug
  const currentSlugs = new Set();
  const newUrls = [];

  for (const url of allUrls) {
    const slug = url.split('/drugs/')[1] || '';
    // Remove trailing numeric ID (e.g., "-623550")
    const nameSlug = slug.replace(/-\d+$/, '').replace(/-/g, ' ').toLowerCase().trim();
    currentSlugs.add(nameSlug);

    // Mark as "new" if not roughly matching existing dataset
    if (!existingBrands.has(nameSlug)) {
      newUrls.push(url);
    }
  }

  const gap = allUrls.size - existingBrands.size;
  const gapPercent = ((gap / existingBrands.size) * 100).toFixed(1);

  console.log(`\n📊 7-Month Gap Report (Oct 2025 → May 2026)`);
  console.log(`  ┌─────────────────────────────────────────`);
  console.log(`  │ Oct 2025 dataset:     ${existingBrands.size.toLocaleString()} medicines`);
  console.log(`  │ 1mg today:            ${allUrls.size.toLocaleString()} medicines`);
  console.log(`  │ Net difference:       +${gap.toLocaleString()} medicines (+${gapPercent}%)`);
  console.log(`  │ Approx new per month: ~${Math.round(gap / 7).toLocaleString()} medicines`);
  console.log(`  │ Approx new per week:  ~${Math.round(gap / 28).toLocaleString()} medicines`);
  console.log(`  └─────────────────────────────────────────`);
  console.log(`\n  ⚠️  These ${newUrls.length.toLocaleString()} medicines are NOT in your database.`);
  console.log(`     Run the weekly scraper to fetch them.\n`);

  // Step 4: Save index (mark ALL current URLs as seen)
  console.log(`Step 4: Saving index (${allUrls.size.toLocaleString()} entries)...`);
  const index = {};
  for (const url of allUrls) {
    index[url] = today; // Mark as seen today
  }
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  console.log(`  ✅ Saved to ${INDEX_FILE}`);

  // Step 5: Save list of new medicines for scraper to pick up
  const NEW_URLS_FILE = path.join(DATA_DIR, 'new_medicines_to_scrape.json');
  fs.writeFileSync(NEW_URLS_FILE, JSON.stringify(newUrls, null, 2));
  console.log(`  ✅ New medicines list saved to ${NEW_URLS_FILE}`);

  console.log(`\nNext steps:`);
  console.log(`  1. Run: node scripts/scrape_1mg_weekly.js`);
  console.log(`     → Will only scrape the ${newUrls.length.toLocaleString()} new medicines`);
  console.log(`  2. Run weekly from now on (cron Monday 2 AM)`);
  console.log(`     → Will only pick up medicines added after ${today}`);
})();
