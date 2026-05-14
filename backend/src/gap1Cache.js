'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const CACHE_FILE = path.join(DATA_DIR, 'gap1_cache.csv');
const HEADERS = ['brand_name_lc','generic_name','active_ingredients','drug_a','drug_b','severity','side_effects','mechanism','clinical_action','confidence','created_at'];

class Gap1Cache {
  constructor() {
    // brand_lc → { generic_name, active_ingredients, interactions: Map(drug_b → {severity, ...}) }
    this.medicines = new Map();
    // 'drug_a|drug_b' → { severity, side_effects, mechanism, clinical_action }
    this.pairIndex = new Map();
    this._load();
  }

  _load() {
    if (!fs.existsSync(CACHE_FILE)) {
      fs.writeFileSync(CACHE_FILE, HEADERS.join(',') + '\n');
      return;
    }
    try {
      const raw = fs.readFileSync(CACHE_FILE);
      const rows = parse(raw, { columns: true, skip_empty_lines: true });
      for (const r of rows) {
        this._indexRow(r);
      }
      console.log(`[gap1Cache] loaded ${rows.length} cached rows`);
    } catch (e) {
      console.error('[gap1Cache] load error:', e.message);
    }
  }

  _indexRow(r) {
    const brandLc = r.brand_name_lc;
    if (!this.medicines.has(brandLc)) {
      this.medicines.set(brandLc, {
        generic_name: r.generic_name,
        active_ingredients: r.active_ingredients ? r.active_ingredients.split('|') : [],
        interactions: new Map(),
      });
    }
    if (r.drug_b) {
      this.medicines.get(brandLc).interactions.set(r.drug_b, {
        severity: r.severity,
        side_effects: r.side_effects,
        mechanism: r.mechanism,
        clinical_action: r.clinical_action,
      });
      const [da, db] = r.drug_a < r.drug_b ? [r.drug_a, r.drug_b] : [r.drug_b, r.drug_a];
      this.pairIndex.set(`${da}|${db}`, {
        severity: r.severity,
        side_effects: r.side_effects,
        mechanism: r.mechanism,
        clinical_action: r.clinical_action,
      });
    }
  }

  getMedicine(brandName) {
    return this.medicines.get(brandName.toLowerCase()) || null;
  }

  getPair(drugA, drugB) {
    const [da, db] = drugA < drugB ? [drugA, drugB] : [drugB, drugA];
    return this.pairIndex.get(`${da}|${db}`) || null;
  }

  save(brandName, geminiData) {
    const brandLc = brandName.toLowerCase();
    const activeIngs = geminiData.active_ingredients || [];
    const allInteractions = [
      ...(geminiData.prescription_interactions || []),
      ...(geminiData.common_interactions || []),
    ];

    const rows = [];
    const now = new Date().toISOString().split('T')[0];

    if (allInteractions.length === 0) {
      // Save medicine with no interactions found
      rows.push({
        brand_name_lc: brandLc,
        generic_name: geminiData.generic_name || '',
        active_ingredients: activeIngs.join('|'),
        drug_a: brandLc,
        drug_b: '',
        severity: '',
        side_effects: '',
        mechanism: '',
        clinical_action: '',
        confidence: geminiData.confidence || 0,
        created_at: now,
      });
    } else {
      for (const it of allInteractions) {
        if (!it.drug || it.severity === 'Safe') continue;
        rows.push({
          brand_name_lc: brandLc,
          generic_name: geminiData.generic_name || '',
          active_ingredients: activeIngs.join('|'),
          drug_a: brandLc,
          drug_b: it.drug.toLowerCase(),
          severity: it.severity,
          side_effects: it.side_effects || '',
          mechanism: it.mechanism || '',
          clinical_action: it.clinical_action || '',
          confidence: geminiData.confidence || 0,
          created_at: now,
        });
      }
      // If every interaction was filtered out, still register the medicine
      // so future queries hit the cache and the brand resolves correctly.
      if (rows.length === 0) {
        rows.push({
          brand_name_lc: brandLc,
          generic_name: geminiData.generic_name || '',
          active_ingredients: activeIngs.join('|'),
          drug_a: brandLc,
          drug_b: '',
          severity: '',
          side_effects: '',
          mechanism: '',
          clinical_action: '',
          confidence: geminiData.confidence || 0,
          created_at: now,
        });
      }
    }

    // Append to CSV
    const csv = stringify(rows, { header: false, columns: HEADERS });
    fs.appendFileSync(CACHE_FILE, csv);

    // Index in memory
    for (const r of rows) this._indexRow(r);

    console.log(`[gap1Cache] saved ${rows.length} rows for "${brandName}"`);
    return rows.length;
  }
}

module.exports = { Gap1Cache };
