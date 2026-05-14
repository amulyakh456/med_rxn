'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const CACHE_FILE = path.join(DATA_DIR, 'gap3_cache.csv');

class Gap3Cache {
  constructor() {
    // ingredient → { interactions: Map(drug_b → {severity, side_effects, mechanism, clinical_action}) }
    this.ingredients = new Map();
    this._load();
  }

  _load() {
    if (!fs.existsSync(CACHE_FILE)) {
      return;
    }
    try {
      const raw = fs.readFileSync(CACHE_FILE);
      const rows = parse(raw, { columns: true, skip_empty_lines: true });
      for (const r of rows) {
        this._indexRow(r);
      }
      console.log(`[gap3Cache] loaded ${rows.length} cached rows`);
    } catch (e) {
      console.error('[gap3Cache] load error:', e.message);
    }
  }

  _indexRow(r) {
    const ing = r.ingredient;
    if (!ing) return;
    if (!this.ingredients.has(ing)) {
      this.ingredients.set(ing, { interactions: new Map() });
    }
    // Only add if this is an actual interaction (not an "no interactions found" placeholder)
    if (r.drug_b) {
      this.ingredients.get(ing).interactions.set(r.drug_b, {
        severity: r.severity,
        side_effects: r.side_effects,
        mechanism: r.mechanism,
        clinical_action: r.clinical_action,
      });
    }
  }

  // Get all interactions for an ingredient
  getIngredient(ingredientName) {
    const key = ingredientName.toLowerCase();
    return this.ingredients.get(key) || null;
  }

  // Get a specific drug interaction for an ingredient
  getInteraction(ingredient, drugB) {
    const ing = this.getIngredient(ingredient);
    if (!ing) return null;
    return ing.interactions.get(drugB.toLowerCase()) || null;
  }
}

module.exports = { Gap3Cache };
