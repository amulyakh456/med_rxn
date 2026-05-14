/**
 * Update database with newly scraped medicines.
 *
 * Takes the diff report and:
 * 1. INSERTs new medicines into rx.medicines + rx.medicine_ingredients
 * 2. UPDATEs prices for existing medicines
 * 3. Logs what was changed (for audit trail)
 *
 * Requires: Postgres connection (DATABASE_URL env var)
 *
 * Run: node scripts/update_db_from_scrape.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DIFF_REPORT = path.join(DATA_DIR, 'diff_report.json');
const NEW_FILE = path.join(DATA_DIR, '1mg_medicines_weekly.csv');

// ---- TODO: Add Postgres connection ----
// Currently this is a dry-run/planning script
// To use with actual DB:
// const { Pool } = require('pg');
// const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---- Load new medicines ----
function loadNewMedicines() {
  if (!fs.existsSync(NEW_FILE)) {
    console.error('New medicines file not found:', NEW_FILE);
    process.exit(1);
  }
  const raw = fs.readFileSync(NEW_FILE, 'utf-8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  return rows;
}

// ---- Load diff report ----
function loadDiffReport() {
  if (!fs.existsSync(DIFF_REPORT)) {
    console.error('Diff report not found:', DIFF_REPORT);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(DIFF_REPORT, 'utf-8'));
}

// ---- Parse ingredients string into array ----
function parseIngredients(ingredientStr) {
  if (!ingredientStr) return [];
  return ingredientStr.split(' | ').map(s => s.trim()).filter(Boolean);
}

// ---- Main (dry-run for now) ----
(async () => {
  const report = loadDiffReport();
  const allMeds = loadNewMedicines();

  console.log('📋 Database Update Plan\n');
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`\n1️⃣  INSERT ${report.summary.new_medicines} new medicines`);
  for (const med of report.new_medicines.slice(0, 5)) {
    const ingredients = parseIngredients(med.ingredients);
    console.log(`    - ${med.brand_name} (${med.generic_name}, ${ingredients.length} ingredients)`);
  }
  if (report.summary.new_medicines > 5) {
    console.log(`    ... and ${report.summary.new_medicines - 5} more`);
  }

  console.log(`\n2️⃣  UPDATE ${report.summary.price_changes} price changes`);
  for (const change of report.price_changes.slice(0, 5)) {
    console.log(`    - ${change.brand_name}: ${change.old_price} → ${change.new_price}`);
  }
  if (report.summary.price_changes > 5) {
    console.log(`    ... and ${report.summary.price_changes - 5} more`);
  }

  console.log(`\n3️⃣  ARCHIVE ${report.summary.removed_medicines} removed medicines`);
  for (const med of report.removed_medicines.slice(0, 5)) {
    console.log(`    - ${med.brand_name}`);
  }
  if (report.summary.removed_medicines > 5) {
    console.log(`    ... and ${report.summary.removed_medicines - 5} more`);
  }

  console.log(`\n\n🔔 Next steps:`);
  console.log(`1. Review diff report: ${DIFF_REPORT}`);
  console.log(`2. If new medicines need enrichment, enrich them:`);
  console.log(`   - Extract new drug pairs`);
  console.log(`   - Run Gemini enrichment`);
  console.log(`   - Update rx.interactions table`);
  console.log(`3. Connect to Postgres and run actual inserts/updates`);
  console.log(`4. Log changes to audit table (timestamp, action, count)`);

  // Example SQL (not executed):
  console.log(`\n\n📝 Example SQL (not executed):`);
  console.log(`\n-- Insert new medicine:`);
  console.log(`INSERT INTO rx.medicines (brand_name, brand_lc, brand_family, generic_name, dosage, dosage_form, manufacturer, price)`);
  console.log(`VALUES ('Aspirin 500', 'aspirin 500', 'aspirin', 'Acetylsalicylic Acid', '500mg', 'Tablet', 'Bayer', '₹25');`);
  console.log(`\n-- Insert ingredients:`);
  console.log(`INSERT INTO rx.medicine_ingredients (medicine_id, ingredient, ingredient_position, ingredient_count)`);
  console.log(`VALUES (12345, 'acetylsalicylic acid', 1, 1);`);
  console.log(`\n-- Update price:`);
  console.log(`UPDATE rx.medicines SET price = '₹30', updated_at = NOW() WHERE brand_name = 'Aspirin 500';`);
})();
