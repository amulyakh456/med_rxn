/**
 * Diff script: Compare old medicines CSV against newly scraped data.
 * Identifies: new medicines, removed medicines, updated medicines.
 *
 * Run: node scripts/diff_medicines.js
 * Output: prints summary and creates diff report
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OLD_FILE = path.join(DATA_DIR, '1mg_medicines_normalized.csv');
const NEW_FILE = path.join(DATA_DIR, '1mg_medicines_weekly.csv');
const DIFF_REPORT = path.join(DATA_DIR, 'diff_report.json');

// ---- Load CSV as map (brand_name -> full row) ----
function loadMedicines(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  const map = {};
  for (const row of rows) {
    if (row.brand_name) {
      map[row.brand_name.toLowerCase()] = row;
    }
  }
  return map;
}

// ---- Main ----
(async () => {
  console.log('Loading medicines...');
  const oldMeds = loadMedicines(OLD_FILE);
  const newMeds = loadMedicines(NEW_FILE);

  const oldBrands = Object.keys(oldMeds);
  const newBrands = Object.keys(newMeds);

  const newMedicines = newBrands.filter(b => !oldMeds[b]);
  const removedMedicines = oldBrands.filter(b => !newMeds[b]);
  const common = oldBrands.filter(b => newMeds[b]);

  // Find price changes
  const priceChanges = [];
  for (const brand of common) {
    const oldPrice = oldMeds[brand].price;
    const newPrice = newMeds[brand].price;
    if (oldPrice !== newPrice) {
      priceChanges.push({
        brand_name: brand,
        old_price: oldPrice,
        new_price: newPrice,
      });
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      old_count: oldBrands.length,
      new_count: newBrands.length,
      new_medicines: newMedicines.length,
      removed_medicines: removedMedicines.length,
      price_changes: priceChanges.length,
      net_change: newBrands.length - oldBrands.length,
    },
    new_medicines: newMedicines.map(b => newMeds[b]),
    removed_medicines: removedMedicines.map(b => oldMeds[b]),
    price_changes: priceChanges.slice(0, 50), // First 50
  };

  fs.writeFileSync(DIFF_REPORT, JSON.stringify(report, null, 2));

  console.log(`\n📊 Diff Report`);
  console.log(`  Old medicines: ${report.summary.old_count}`);
  console.log(`  New medicines: ${report.summary.new_count}`);
  console.log(`  ➕ New SKUs: ${report.summary.new_medicines}`);
  console.log(`  ➖ Removed SKUs: ${report.summary.removed_medicines}`);
  console.log(`  💰 Price changes: ${report.summary.price_changes}`);
  console.log(`  📈 Net change: ${report.summary.net_change > 0 ? '+' : ''}${report.summary.net_change}`);
  console.log(`\nFull report: ${DIFF_REPORT}`);
})();
