/**
 * Load all enriched data into the database (CSV files for in-memory backend).
 *
 * Combines:
 *   - pass1_known.json + pass2_known.json (160k new medicines + ingredients)
 *   - gap5_cache.csv (enriched interactions with clinical_effect)
 *   - existing canonical_generics.csv (3,780 known ingredients)
 *
 * Produces:
 *   - data/1mg_medicines_normalized.csv (updated: ~410k medicines)
 *   - data/canonical_generics.csv (updated: ~5,800 ingredients)
 *   - data/interactions.csv (updated with severity + clinical_effect)
 *   - data/brand_to_generics.csv (rebuilt)
 *
 * Originals are backed up to data/backup_<timestamp>/
 *
 * Run: node scripts/load_into_db.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, `backup_${Date.now()}`);

// Inputs
const PASS1_KNOWN = path.join(DATA_DIR, 'pass1_known.json');
const PASS2_KNOWN = path.join(DATA_DIR, 'pass2_known.json');
const GAP5_CACHE = path.join(DATA_DIR, 'gap5_cache.csv');

// Targets to update
const MEDICINES_CSV = path.join(DATA_DIR, '1mg_medicines_normalized.csv');
const GENERICS_CSV = path.join(DATA_DIR, 'canonical_generics.csv');
const INTERACTIONS_CSV = path.join(DATA_DIR, 'interactions.csv');
const BRAND_TO_GENERICS = path.join(DATA_DIR, 'brand_to_generics.csv');

// ---- Helpers ----
function backup(file) {
  if (!fs.existsSync(file)) return;
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
  const dest = path.join(BACKUP_DIR, path.basename(file));
  fs.copyFileSync(file, dest);
}

function loadCsv(file) {
  if (!fs.existsSync(file)) return [];
  return parse(fs.readFileSync(file), { columns: true, skip_empty_lines: true });
}

function brandFamily(brandName) {
  // Extract first word, lowercase, strip numbers/dosage hints
  return brandName.toLowerCase().split(' ')[0].replace(/[\d.]/g, '').trim();
}

// ---- Main ----
(async () => {
  console.log('🔒 Backing up existing files...');
  [MEDICINES_CSV, GENERICS_CSV, INTERACTIONS_CSV, BRAND_TO_GENERICS].forEach(backup);
  console.log(`   Saved to: ${BACKUP_DIR}\n`);

  // ---- Load all data ----
  console.log('📂 Loading data...');
  const p1 = JSON.parse(fs.readFileSync(PASS1_KNOWN));
  const p2 = JSON.parse(fs.readFileSync(PASS2_KNOWN));
  const newMedicines = [...p1, ...p2];
  console.log(`   New medicines (Pass 1+2): ${newMedicines.length.toLocaleString()}`);

  const gap5 = loadCsv(GAP5_CACHE);
  console.log(`   Enriched interactions:    ${gap5.length.toLocaleString()}`);

  const existingMeds = loadCsv(MEDICINES_CSV);
  console.log(`   Existing medicines:       ${existingMeds.length.toLocaleString()}`);

  const existingGenerics = loadCsv(GENERICS_CSV);
  console.log(`   Existing generics:        ${existingGenerics.length.toLocaleString()}`);

  const existingInteractions = loadCsv(INTERACTIONS_CSV);
  console.log(`   Existing interactions:    ${existingInteractions.length.toLocaleString()}\n`);

  // ---- 1) Build medicines CSV (merge new with existing) ----
  console.log('🔧 Step 1: Merging medicines...');
  const existingBrands = new Set(
    existingMeds.map(m => m.brand_name?.toLowerCase().replace(/\//g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean)
  );

  const medicinesOut = [...existingMeds];
  let addedMeds = 0;

  for (const m of newMedicines) {
    if (!m.brand || !Array.isArray(m.ingredients) || m.ingredients.length === 0) continue;
    const brandLc = m.brand.toLowerCase().replace(/\s+/g, ' ').trim();
    if (existingBrands.has(brandLc)) continue;

    medicinesOut.push({
      brand_name: m.brand,
      generic_name: m.ingredients.join(' + '),
      dosage: '',
      dosage_form: '',
      manufacturer: '',
      pack_size: '',
      price: '',
      prescription_required: '',
    });
    existingBrands.add(brandLc);
    addedMeds++;
  }

  fs.writeFileSync(MEDICINES_CSV, stringify(medicinesOut, {
    header: true,
    columns: ['brand_name','generic_name','dosage','dosage_form','manufacturer','pack_size','price','prescription_required'],
  }));
  console.log(`   Added ${addedMeds.toLocaleString()} new medicines (total: ${medicinesOut.length.toLocaleString()})\n`);

  // ---- 2) Build canonical_generics (count occurrences) ----
  console.log('🔧 Step 2: Rebuilding canonical_generics...');
  const ingredientCounts = {};
  for (const row of existingGenerics) {
    ingredientCounts[row.ingredient.toLowerCase().trim()] = parseInt(row.occurrence_count || 0, 10);
  }
  for (const m of newMedicines) {
    if (!Array.isArray(m.ingredients)) continue;
    for (const ing of m.ingredients) {
      if (!ing) continue;
      const norm = ing.toLowerCase().trim();
      ingredientCounts[norm] = (ingredientCounts[norm] || 0) + 1;
    }
  }

  const genericsOut = Object.entries(ingredientCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([ingredient, count]) => ({ ingredient, occurrence_count: count }));

  fs.writeFileSync(GENERICS_CSV, stringify(genericsOut, {
    header: true,
    columns: ['ingredient', 'occurrence_count'],
  }));
  console.log(`   Total unique ingredients: ${genericsOut.length.toLocaleString()} (+${(genericsOut.length - existingGenerics.length).toLocaleString()} new)\n`);

  // ---- 3) Merge interactions (existing + gap5_cache enrichments) ----
  console.log('🔧 Step 3: Merging interactions...');
  const interactionMap = new Map();

  // Start with existing interactions (severity only)
  for (const row of existingInteractions) {
    const [a, b] = row.drug_a < row.drug_b ? [row.drug_a, row.drug_b] : [row.drug_b, row.drug_a];
    interactionMap.set(`${a}|${b}`, {
      drug_a: a,
      drug_b: b,
      severity: row.severity || 'Unknown',
      clinical_effect: row.clinical_effect || '',
    });
  }

  // Merge gap5_cache (adds clinical_effect, may add new pairs)
  let updated = 0, added = 0;
  for (const row of gap5) {
    const dA = row.drug_a.toLowerCase().trim();
    const dB = row.drug_b.toLowerCase().trim();
    if (dA === dB) continue;
    const [a, b] = dA < dB ? [dA, dB] : [dB, dA];
    const key = `${a}|${b}`;

    if (interactionMap.has(key)) {
      const existing = interactionMap.get(key);
      if (!existing.clinical_effect && row.clinical_effect) {
        existing.clinical_effect = row.clinical_effect;
        existing.severity = row.severity || existing.severity;
        updated++;
      }
    } else {
      interactionMap.set(key, {
        drug_a: a,
        drug_b: b,
        severity: row.severity || 'Unknown',
        clinical_effect: row.clinical_effect || '',
      });
      added++;
    }
  }

  const interactionsOut = [...interactionMap.values()];
  fs.writeFileSync(INTERACTIONS_CSV, stringify(interactionsOut, {
    header: true,
    columns: ['drug_a', 'drug_b', 'severity', 'clinical_effect'],
  }));
  console.log(`   Total interactions: ${interactionsOut.length.toLocaleString()} (+${added.toLocaleString()} new, ${updated.toLocaleString()} updated with clinical_effect)\n`);

  // ---- 4) Rebuild brand_to_generics ----
  console.log('🔧 Step 4: Rebuilding brand_to_generics...');
  const brandToGenericsOut = [];
  for (const m of medicinesOut) {
    if (!m.generic_name) continue;
    const generics = m.generic_name.split('+').map(g => g.trim()).filter(Boolean);
    for (let i = 0; i < generics.length; i++) {
      brandToGenericsOut.push({
        brand_name: m.brand_name,
        ingredient: generics[i].toLowerCase(),
        ingredient_position: i + 1,
        ingredient_count: generics.length,
      });
    }
  }
  fs.writeFileSync(BRAND_TO_GENERICS, stringify(brandToGenericsOut, {
    header: true,
    columns: ['brand_name', 'ingredient', 'ingredient_position', 'ingredient_count'],
  }));
  console.log(`   Total brand-to-generic rows: ${brandToGenericsOut.length.toLocaleString()}\n`);

  // ---- Summary ----
  console.log('✅ Database load complete!\n');
  console.log('📊 Final Counts:');
  console.log(`  ┌──────────────────────────────────────`);
  console.log(`  │ Medicines:        ${medicinesOut.length.toLocaleString()}`);
  console.log(`  │ Unique generics:  ${genericsOut.length.toLocaleString()}`);
  console.log(`  │ Interactions:     ${interactionsOut.length.toLocaleString()}`);
  console.log(`  │ Brand→Generic:    ${brandToGenericsOut.length.toLocaleString()}`);
  console.log(`  └──────────────────────────────────────\n`);

  console.log('🔄 Restart the backend to load new data:');
  console.log('   cd backend && npm run dev');
  console.log('\n📌 For production Postgres: run scripts/generate_migration_sql.js');
})();
