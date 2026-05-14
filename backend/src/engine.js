/**
 * In-memory drug interaction engine.
 *
 * On startup, loads three CSVs from /data/:
 *   - 1mg_medicines_normalized.csv  (252,997 rows)
 *   - canonical_generics.csv         (3,780 rows)
 *   - interactions.csv               (224,449 rows)
 *
 * Memory footprint is ~150 MB. Initial load takes ~3-5 seconds.
 *
 * For production (recordrx), use the Postgres-backed version in /node/src.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// ---- India -> DDInter name normalization ----
const INDIA_TO_DDINTER = {
  'paracetamol': 'acetaminophen',
  'lignocaine': 'lidocaine',
  'lignocain': 'lidocaine',
  'glibenclamide': 'glyburide',
  'frusemide': 'furosemide',
  'adrenaline': 'epinephrine',
  'noradrenaline': 'norepinephrine',
  'tazobactum': 'tazobactam',
  'amoxycillin': 'amoxicillin',
  'amoxycillin trihydrate': 'amoxicillin',
  'cyclosporin': 'cyclosporine',
  'ciclosporin': 'cyclosporine',
  'phenobarbitone': 'phenobarbital',
  'thiopentone': 'thiopental',
  'pethidine': 'meperidine',
  'rifampicin': 'rifampin',
  'sulphamethoxazole': 'sulfamethoxazole',
  'aspirin': 'acetylsalicylic acid',
};

const SALT_SUFFIXES = [
  'Hydrochloride','Dihydrochloride','Trihydrate','Monohydrate','Dihydrate',
  'Hydrobromide','Mesylate','Maleate','Tartrate','Succinate','Acetate',
  'Phosphate','Citrate','Sulphate','Sulfate','Bromide','Chloride','Iodide',
  'Fumarate','Oxalate','Furoate','Aceponate','Propionate','Valerate',
  'Pivalate','Pamoate','Lactate','Gluconate','Sodium','Potassium',
  'Calcium','Magnesium','Zinc','HCl','HBr','Besylate','Tosylate',
  'Nitrate','Bicarbonate','Carbonate','Stearate','Palmitate',
  'Hemifumarate','Decanoate','Enanthate','Cypionate',
  'Disodium','Dipotassium','Camsylate',
].sort((a, b) => b.length - a.length);

function stripSalt(name) {
  let s = String(name || '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const salt of SALT_SUFFIXES) {
      if (s.endsWith(' ' + salt) || s.endsWith(' ' + salt.toLowerCase())) {
        s = s.slice(0, s.length - salt.length - 1).replace(/\s+$/, '');
        changed = true;
        break;
      }
    }
  }
  return s;
}

function normalizeToDDInter(indianName) {
  if (!indianName) return '';
  let s = String(indianName).trim().replace(/\s+/g, ' ');
  const base = stripSalt(s);
  for (const c of [s.toLowerCase(), base.toLowerCase()]) {
    if (INDIA_TO_DDINTER[c]) return INDIA_TO_DDINTER[c];
  }
  return base.toLowerCase();
}

// ---- Brand-family extraction ----
const FORM_TOKENS = new Set([
  'tablet','tablets','capsule','capsules','syrup','injection','cream','ointment','gel',
  'lotion','drops','suspension','spray','powder','sachet','patch','lozenge','solution',
  'shampoo','soap','infusion','elixir','inhaler','rotacaps','respules','granules',
  'er','sr','mr','dt','pr','cr','od','xl','duo',
]);

function brandFamily(name) {
  let s = String(name || '').toLowerCase();
  s = s.replace(/\d+(?:\.\d+)?\s*(mg|mcg|ml|g|gm|iu|%|w\/w|w\/v)\b/g, '');
  s = s.replace(/[\(\)\|/]/g, ' ');
  return s
    .split(/\s+/)
    .filter(t => t && !FORM_TOKENS.has(t) && !/^\d+(?:\.\d+)?$/.test(t))
    .join(' ')
    .trim();
}

// ---- Engine ----
class InteractionEngine {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.medicines = [];                 // [{brand_name, generic_name, ...}]
    this.byBrandLc = new Map();          // brand_lc -> medicine record (first match)
    this.byFamily = new Map();           // family -> medicine record[] (all SKUs in family)
    this.allBrandsLc = [];               // for substring scan
    this.familyKeys = [];                // for prefix scan / fuzzy
    this.knownDDInterDrugs = new Set();
    this.pairIndex = new Map();          // 'a|b' (alpha sorted) -> { severity, clinical_effect }
  }

  load() {
    const t0 = Date.now();

    // ---- medicines ----
    const medsRaw = fs.readFileSync(path.join(this.dataDir, '1mg_medicines_normalized.csv'));
    const meds = parse(medsRaw, { columns: true, skip_empty_lines: true });
    for (const r of meds) {
      r.brand_lc = String(r.brand_name || '').toLowerCase();
      r.brand_family = brandFamily(r.brand_name);
      this.medicines.push(r);
      if (!this.byBrandLc.has(r.brand_lc)) this.byBrandLc.set(r.brand_lc, r);
      if (!this.byFamily.has(r.brand_family)) this.byFamily.set(r.brand_family, []);
      this.byFamily.get(r.brand_family).push(r);
    }
    this.allBrandsLc = this.medicines.map(m => m.brand_lc);
    this.familyKeys = [...this.byFamily.keys()];

    // ---- interactions ----
    const interFile = fs.existsSync(path.join(this.dataDir, 'interactions_full.csv'))
      ? 'interactions_full.csv' : 'interactions.csv';
    const interRaw = fs.readFileSync(path.join(this.dataDir, interFile));
    const inter = parse(interRaw, { columns: true, skip_empty_lines: true });
    const NO_INTERACTION_RE = new RegExp(
      [
        // "no <anything up to 10 words> interaction(s)"
        '\\bno\\s+(\\w+\\s+){0,10}interactions?\\b',
        // "not clinically significant" / "not expected to interact" / "not known to interact"
        '\\bnot\\s+(clinically\\s+)?(significant|expected\\s+to\\s+interact|known\\s+to\\s+interact)\\b',
        // "does not / do not (clinically) interact"
        'do(es)?\\s+not\\s+(clinically\\s+)?interact\\b',
        // "are not known to interact"
        'are\\s+not\\s+known\\s+to\\s+interact\\b',
        // "no ... interaction(s) are/is expected/known/reported"
        'no\\s+(direct\\s+|known\\s+|notable\\s+|major\\s+|relevant\\s+|important\\s+|clinically\\s+|pharmacokinetic\\s+|pharmacodynamic\\s+)*interactions?\\s+(are\\s+|is\\s+|have\\s+been\\s+)?(expected|known|reported|noted|anticipated|documented|established)\\b',
      ].join('|'),
      'i'
    );
    let skipped = 0;
    for (const r of inter) {
      const a = r.drug_a;
      const b = r.drug_b;
      const effect = r.clinical_effect || '';
      if (effect && NO_INTERACTION_RE.test(effect)) {
        this.knownDDInterDrugs.add(a);
        this.knownDDInterDrugs.add(b);
        skipped++;
        continue;
      }
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      this.pairIndex.set(key, { severity: r.severity, clinical_effect: effect });
      this.knownDDInterDrugs.add(a);
      this.knownDDInterDrugs.add(b);
    }
    if (skipped) console.log(`[engine] skipped ${skipped} pairs with "no significant interaction" text`);
    console.log(`[engine] loaded interactions from ${interFile}`);

    const ms = Date.now() - t0;
    console.log(`[engine] loaded in ${ms} ms — ${this.medicines.length.toLocaleString()} meds, ${this.pairIndex.size.toLocaleString()} pairs, ${this.knownDDInterDrugs.size.toLocaleString()} DDInter drugs`);
  }

  // ---- search (autocomplete) ----
  search(q, limit = 10) {
    q = String(q || '').trim().toLowerCase();
    if (q.length < 2) return [];
    const out = [];
    const seen = new Set();
    // Prefer family-prefix
    for (const m of this.medicines) {
      if (m.brand_family.startsWith(q)) {
        if (!seen.has(m.brand_name)) { out.push(m); seen.add(m.brand_name); }
        if (out.length >= limit) break;
      }
    }
    // Fill with substring
    if (out.length < limit) {
      for (const m of this.medicines) {
        if (m.brand_lc.includes(q) && !seen.has(m.brand_name)) {
          out.push(m); seen.add(m.brand_name);
          if (out.length >= limit) break;
        }
      }
    }
    return out.map(m => ({
      brand_name: m.brand_name,
      generic_name: m.generic_name,
      dosage: m.dosage || '',
      dosage_form: m.dosage_form || '',
      manufacturer: m.manufacturer || '',
    }));
  }

  // ---- brand lookup (tiered) ----
  lookupBrand(query) {
    const q = String(query || '').trim();
    if (!q) return null;
    const ql = q.toLowerCase();
    const qf = brandFamily(q);

    // Tier 1: exact
    const exact = this.byBrandLc.get(ql);
    if (exact) return this._fill(q, exact, 'exact');

    // Tier 2: family equality
    if (qf && this.byFamily.has(qf)) {
      const list = this.byFamily.get(qf);
      return this._fill(q, list[0], 'family');
    }

    // Tier 3: substring on brand_lc
    const sub = this.medicines.find(m => m.brand_lc.includes(ql));
    if (sub) return this._fill(q, sub, 'substring');

    // Tier 4: substring on family
    if (qf) {
      const subFam = this.medicines.find(m => m.brand_family.includes(qf));
      if (subFam) return this._fill(q, subFam, 'family-substring');
    }

    return null;
  }

  _fill(input, m, confidence) {
    return {
      input,
      matched_brand: m.brand_name,
      generic_name: m.generic_name,
      ingredients: String(m.generic_name).split('+').map(s => s.trim()).filter(Boolean),
      dosage: m.dosage || '',
      dosage_form: m.dosage_form || '',
      manufacturer: m.manufacturer || '',
      confidence,
    };
  }

  // ---- main check (sync, DDInter only) ----
  check(brands) {
    const result = {
      inputs: [...brands],
      resolved_brands: [],
      unresolved_brands: [],
      no_data_ingredients: [],
      interactions: [],
      severity_summary: { Major: 0, Moderate: 0, Minor: 0, Unknown: 0 },
    };

    const perBrand = [];
    for (const b of brands) {
      const r = this.lookupBrand(b);
      if (!r) { result.unresolved_brands.push(b); continue; }
      const ings = r.ingredients.map(name => {
        const ddi = normalizeToDDInter(name);
        const known = this.knownDDInterDrugs.has(ddi);
        if (!known && !result.no_data_ingredients.includes(name)) {
          result.no_data_ingredients.push(name);
        }
        return { ingredient: name, ddinter_name: known ? ddi : null };
      });
      result.resolved_brands.push({
        input: r.input,
        matched_brand: r.matched_brand,
        ingredients: ings,
      });
      perBrand.push({ brand: r.matched_brand, ings });
    }

    // pairwise check
    for (let i = 0; i < perBrand.length; i++) {
      for (let j = i + 1; j < perBrand.length; j++) {
        for (const a of perBrand[i].ings) {
          if (!a.ddinter_name) continue;
          for (const b of perBrand[j].ings) {
            if (!b.ddinter_name || a.ddinter_name === b.ddinter_name) continue;
            const [da, db] = a.ddinter_name < b.ddinter_name
              ? [a.ddinter_name, b.ddinter_name]
              : [b.ddinter_name, a.ddinter_name];
            const pair = this.pairIndex.get(`${da}|${db}`);
            if (pair) {
              result.interactions.push({
                severity: pair.severity,
                clinical_effect: pair.clinical_effect,
                brand_a: perBrand[i].brand,
                brand_b: perBrand[j].brand,
                ingredient_a: a.ingredient,
                ingredient_b: b.ingredient,
                drug_a: da, drug_b: db,
              });
              result.severity_summary[pair.severity] = (result.severity_summary[pair.severity] || 0) + 1;
            }
          }
        }
      }
    }

    const rank = { Major: 0, Moderate: 1, Minor: 2, Unknown: 3 };
    result.interactions.sort((x, y) => rank[x.severity] - rank[y.severity]);
    return result;
  }

  // ---- Gap 1: async check with Gemini fallback for unresolved brands ----
  async checkWithGap1Fallback(brands, gap1Cache, geminiEnricher, gap3Cache) {
    // Step 1: run normal DDInter check
    const result = this.check(brands);

    // Step 2: check gap3_cache for no_data_ingredients (free, instant)
    if (gap3Cache && result.no_data_ingredients.length > 0) {
      for (const noDataIng of result.no_data_ingredients) {
        const cached = gap3Cache.getIngredient(noDataIng);
        if (cached && cached.interactions.size > 0) {
          for (const [drugB, interaction] of cached.interactions) {
            if (interaction.severity === 'Safe' || !interaction.severity) continue;

            // find resolved brands that contain drugB as an ingredient
            for (const resolvedBrand of result.resolved_brands) {
              const hasIngredient = resolvedBrand.ingredients &&
                resolvedBrand.ingredients.some(ing =>
                  ing.ingredient.toLowerCase().includes(drugB.toLowerCase()) ||
                  drugB.toLowerCase().includes(ing.ingredient.toLowerCase())
                );

              if (hasIngredient) {
                result.interactions.push({
                  severity: interaction.severity,
                  brand_a: result.resolved_brands.find(r => r.ingredients.some(ing => ing.ingredient === noDataIng))?.matched_brand || noDataIng,
                  brand_b: resolvedBrand.matched_brand,
                  ingredient_a: noDataIng,
                  ingredient_b: drugB,
                  side_effects: interaction.side_effects,
                  mechanism: interaction.mechanism,
                  clinical_action: interaction.clinical_action,
                  source: 'gap3',
                });
                result.severity_summary[interaction.severity] =
                  (result.severity_summary[interaction.severity] || 0) + 1;
              }
            }
          }
        }
      }
    }

    // Step 3: if no unresolved brands, we're done
    if (result.unresolved_brands.length === 0) {
      const rank = { Major: 0, Moderate: 1, Minor: 2, Unknown: 3 };
      result.interactions.sort((x, y) => rank[x.severity] - rank[y.severity]);
      return result;
    }

    const resolvedDrugNames = result.resolved_brands
      .map(r => r.matched_brand);

    for (const unresolvedBrand of result.unresolved_brands) {
      // Step 4: check gap1 cache first (free, instant)
      const cached = gap1Cache.getMedicine(unresolvedBrand);

      let medicineData;
      let source;

      if (cached) {
        medicineData = cached;
        source = 'cache';
        console.log(`[gap1] cache hit for "${unresolvedBrand}"`);
      } else {
        // Step 5: cache miss → call Gemini (~₹0.06)
        console.log(`[gap1] cache miss → calling Gemini for "${unresolvedBrand}"`);
        try {
          const geminiResult = await geminiEnricher.enrichMedicine(
            unresolvedBrand,
            resolvedDrugNames
          );

          const hasUsableData = (geminiResult.active_ingredients?.length || 0) > 0
            && (geminiResult.confidence || 0) >= 0.5;
          if (!geminiResult.is_real_medicine && !hasUsableData) {
            console.log(`[gap1] Gemini says "${unresolvedBrand}" is not a real medicine (confidence=${geminiResult.confidence || 0})`);
            continue;
          }
          if (!geminiResult.is_real_medicine && hasUsableData) {
            console.log(`[gap1] Gemini flagged "${unresolvedBrand}" not-real but returned usable data (confidence=${geminiResult.confidence}) — accepting`);
          }

          // Step 6: save to cache so future calls are free
          gap1Cache.save(unresolvedBrand, geminiResult);
          medicineData = gap1Cache.getMedicine(unresolvedBrand);
          source = 'gemini';
        } catch (e) {
          console.error(`[gap1] Gemini call failed for "${unresolvedBrand}":`, e.message);
          continue;
        }
      }

      if (!medicineData) continue;

      // Step 7: move from unresolved → resolved
      result.unresolved_brands = result.unresolved_brands.filter(b => b !== unresolvedBrand);
      result.resolved_brands.push({
        input: unresolvedBrand,
        matched_brand: unresolvedBrand,
        source,
        generic_name: medicineData.generic_name,
        ingredients: medicineData.active_ingredients.map(i => ({
          ingredient: i,
          ddinter_name: null,
        })),
      });

      // Step 8: add interactions from cache/Gemini to result
      for (const [drugB, interaction] of medicineData.interactions) {
        if (interaction.severity === 'Safe' || !interaction.severity) continue;

        // check if drugB matches any resolved brand
        const matchedBrand = result.resolved_brands.find(r =>
          r.matched_brand.toLowerCase() === drugB ||
          (r.generic_name && r.generic_name.toLowerCase().includes(drugB))
        );

        if (matchedBrand) {
          result.interactions.push({
            severity: interaction.severity,
            brand_a: unresolvedBrand,
            brand_b: matchedBrand.matched_brand,
            ingredient_a: medicineData.generic_name,
            ingredient_b: matchedBrand.generic_name || drugB,
            side_effects: interaction.side_effects,
            mechanism: interaction.mechanism,
            clinical_action: interaction.clinical_action,
            source: 'gap1',
          });
          result.severity_summary[interaction.severity] =
            (result.severity_summary[interaction.severity] || 0) + 1;
        }
      }
    }

    const rank = { Major: 0, Moderate: 1, Minor: 2, Unknown: 3 };
    result.interactions.sort((x, y) => rank[x.severity] - rank[y.severity]);
    return result;
  }
}

module.exports = { InteractionEngine, normalizeToDDInter, brandFamily };
