'use strict';

/**
 * Merges interactions.csv (DDInter severity) + gap5_cache.csv (clinical_effect)
 * into data/interactions_full.csv.
 *
 * Rules:
 *  - Base: all 224,449 pairs from interactions.csv
 *  - Enrich: join clinical_effect from gap5_cache on normalized drug_a|drug_b key
 *  - Dedup gap5_cache: if multiple rows per pair, prefer non-empty clinical_effect,
 *    then take the latest created_at
 *  - Pairs with no clinical_effect get empty string (not silently dropped)
 *
 * Run: node scripts/merge_interactions.js
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const INTERACTIONS_FILE = path.join(DATA_DIR, 'interactions.csv');
const CACHE_FILE = path.join(DATA_DIR, 'gap5_cache.csv');
const OUTPUT_FILE = path.join(DATA_DIR, 'interactions_full.csv');

const key = (a, b) => {
  const [x, y] = a.trim().toLowerCase() < b.trim().toLowerCase()
    ? [a.trim().toLowerCase(), b.trim().toLowerCase()]
    : [b.trim().toLowerCase(), a.trim().toLowerCase()];
  return `${x}|${y}`;
};

console.log('Loading gap5_cache...');
const cacheRaw = fs.readFileSync(CACHE_FILE);
const cacheRows = parse(cacheRaw, { columns: true, skip_empty_lines: true });

// Deduplicate: per pair key, keep row with best clinical_effect (non-empty, latest date)
const enrichMap = new Map();
for (const row of cacheRows) {
  const k = key(row.drug_a, row.drug_b);
  const existing = enrichMap.get(k);
  if (!existing) {
    enrichMap.set(k, row);
  } else {
    const hasEffect = row.clinical_effect && row.clinical_effect.trim();
    const existingHasEffect = existing.clinical_effect && existing.clinical_effect.trim();
    if (hasEffect && (!existingHasEffect || row.created_at >= existing.created_at)) {
      enrichMap.set(k, row);
    }
  }
}
console.log(`gap5_cache: ${cacheRows.length} rows → ${enrichMap.size} unique pairs after dedup`);

console.log('Loading interactions.csv...');
const baseRaw = fs.readFileSync(INTERACTIONS_FILE);
const baseRows = parse(baseRaw, { columns: true, skip_empty_lines: true });
console.log(`interactions.csv: ${baseRows.length} pairs`);

const HEADERS = ['drug_a', 'drug_b', 'severity', 'clinical_effect'];
let matched = 0, unmatched = 0;

const output = baseRows.map(row => {
  const k = key(row.drug_a, row.drug_b);
  const enriched = enrichMap.get(k);
  if (enriched && enriched.clinical_effect && enriched.clinical_effect.trim()) {
    matched++;
    return {
      drug_a: row.drug_a.trim().toLowerCase(),
      drug_b: row.drug_b.trim().toLowerCase(),
      severity: row.severity,
      clinical_effect: enriched.clinical_effect.trim(),
    };
  } else {
    unmatched++;
    return {
      drug_a: row.drug_a.trim().toLowerCase(),
      drug_b: row.drug_b.trim().toLowerCase(),
      severity: row.severity,
      clinical_effect: '',
    };
  }
});

const csv = stringify(output, { header: true, columns: HEADERS });
fs.writeFileSync(OUTPUT_FILE, csv);

console.log(`\n✓ Written: ${OUTPUT_FILE}`);
console.log(`  Total pairs : ${output.length}`);
console.log(`  With effect : ${matched} (${((matched/output.length)*100).toFixed(1)}%)`);
console.log(`  Without     : ${unmatched} (${((unmatched/output.length)*100).toFixed(1)}%)`);
