/**
 * Drug-drug interaction engine for recordrx.
 *
 * Uses the rx.* schema in Postgres/Supabase (see node/sql/01_schema.sql).
 * Engine is stateless aside from the pg pool; safe for concurrent requests.
 *
 *   const { InteractionEngine } = require('./interactionEngine');
 *   const engine = new InteractionEngine(pool);
 *   const result = await engine.check(['Crocin 500', 'Combiflam Tablet']);
 *
 * `pool` is a `pg` Pool instance from the existing recordrx Postgres setup.
 */

'use strict';

// India -> DDInter name map (mirrors scripts/build_interaction_db.py)
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
  'trimethoprim sulphamethoxazole': 'sulfamethoxazole',
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
  let s = (name || '').trim();
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
  const candidates = [s.toLowerCase(), base.toLowerCase()];
  for (const c of candidates) {
    if (INDIA_TO_DDINTER[c]) return INDIA_TO_DDINTER[c];
  }
  return base.toLowerCase();
}

const DOSAGE_FORM_TOKENS = new Set([
  'tablet','tablets','capsule','capsules','syrup','injection','cream','ointment','gel',
  'lotion','drops','suspension','spray','powder','sachet','patch','lozenge','solution',
  'shampoo','soap','infusion','elixir','inhaler','rotacaps','respules','granules',
  'er','sr','mr','dt','pr','cr','od','xl','duo',
]);

function brandFamily(name) {
  let s = (name || '').toLowerCase();
  s = s.replace(/\d+(?:\.\d+)?\s*(mg|mcg|ml|g|gm|iu|%|w\/w|w\/v)\b/g, '');
  s = s.replace(/[\(\)\|/]/g, ' ');
  return s
    .split(/\s+/)
    .filter(t => t && !DOSAGE_FORM_TOKENS.has(t) && !/^\d+(?:\.\d+)?$/.test(t))
    .join(' ')
    .trim();
}


class InteractionEngine {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function') {
      throw new Error('InteractionEngine requires a pg-compatible Pool/Client with .query()');
    }
    this.pool = pool;
  }

  /**
   * Brand name -> { matched_brand, ingredients } using tiered SQL lookup:
   *   1. exact (case-insensitive)
   *   2. family equality
   *   3. brand_lc substring
   *   4. family substring
   *   5. trigram similarity (pg_trgm) when nothing else matches
   */
  async lookupBrand(query) {
    const q = (query || '').trim();
    if (!q) return null;

    const ql = q.toLowerCase();
    const qf = brandFamily(q);

    const sql = `
      WITH ranked AS (
        SELECT m.id, m.brand_name, m.generic_name, m.dosage, m.dosage_form, m.manufacturer,
          CASE
            WHEN m.brand_lc = $1                                            THEN 1  -- exact
            WHEN m.brand_family = $2 AND $2 <> ''                           THEN 2  -- family equal
            WHEN m.brand_lc       LIKE '%' || $1 || '%'                     THEN 3  -- brand substring
            WHEN m.brand_family   LIKE '%' || $2 || '%' AND $2 <> ''        THEN 4  -- family substring
            ELSE 5
          END AS tier,
          similarity(m.brand_family, $2) AS sim
        FROM rx.medicines m
        WHERE m.brand_lc = $1
           OR m.brand_family = $2
           OR m.brand_lc      LIKE '%' || $1 || '%'
           OR m.brand_family  LIKE '%' || $2 || '%'
           OR ($2 <> '' AND m.brand_family % $2)               -- pg_trgm "% similar"
      )
      SELECT * FROM ranked
      ORDER BY tier ASC, sim DESC NULLS LAST, length(brand_name) ASC
      LIMIT 1;
    `;
    const { rows } = await this.pool.query(sql, [ql, qf]);
    if (!rows.length) return null;
    const r = rows[0];

    // Pull ingredients in a follow-up query (small, indexed)
    const ings = await this.pool.query(
      `SELECT ingredient, ingredient_position
         FROM rx.medicine_ingredients
        WHERE medicine_id = $1
        ORDER BY ingredient_position`,
      [r.id]
    );

    return {
      input: q,
      matched_brand: r.brand_name,
      generic_name: r.generic_name,
      dosage: r.dosage,
      dosage_form: r.dosage_form,
      manufacturer: r.manufacturer,
      ingredients: ings.rows.map(x => x.ingredient),
    };
  }

  /**
   * Run full check.
   * @param {string[]} brands  list of brand-name inputs from the prescription
   * @returns {Promise<CheckResult>}
   */
  async check(brands) {
    const result = {
      inputs: [...brands],
      resolved_brands: [],
      unresolved_brands: [],
      no_data_ingredients: [],
      interactions: [],
      severity_summary: { Major: 0, Moderate: 0, Minor: 0, Unknown: 0 },
    };

    // 1) Resolve every brand in parallel
    const resolved = await Promise.all(brands.map(b => this.lookupBrand(b)));

    // 2) For each resolved brand, map ingredients -> ddinter_name (one batched query)
    const allIngs = new Set();
    resolved.forEach(r => r && r.ingredients.forEach(i => allIngs.add(i)));
    const ingMap = new Map();   // our_ingredient -> ddinter_name (or null)
    if (allIngs.size) {
      const ingArr = [...allIngs];
      // Apply our local map; for any not in the map, look up DDInter
      const candidates = ingArr.map(normalizeToDDInter);
      const { rows } = await this.pool.query(
        `SELECT drug AS ddinter_name FROM (
           SELECT DISTINCT drug_a AS drug FROM rx.interactions
           UNION
           SELECT DISTINCT drug_b AS drug FROM rx.interactions
         ) d WHERE drug = ANY($1::text[])`,
        [candidates]
      );
      const known = new Set(rows.map(r => r.ddinter_name));
      ingArr.forEach((ing, i) => {
        const cand = candidates[i];
        ingMap.set(ing, known.has(cand) ? cand : null);
      });
    }

    // 3) Build per-brand resolved info, surface unresolved + no-data
    const perBrand = [];
    for (let i = 0; i < brands.length; i++) {
      const r = resolved[i];
      if (!r) { result.unresolved_brands.push(brands[i]); continue; }
      const ings = r.ingredients.map(name => ({
        ingredient: name,
        ddinter_name: ingMap.get(name) || null,
      }));
      ings.forEach(ing => {
        if (!ing.ddinter_name && !result.no_data_ingredients.includes(ing.ingredient)) {
          result.no_data_ingredients.push(ing.ingredient);
        }
      });
      result.resolved_brands.push({
        input: r.input,
        matched_brand: r.matched_brand,
        ingredients: ings,
      });
      perBrand.push({ brand: r.matched_brand, ings });
    }

    // 4) Pairwise check ACROSS different brands; collect (drug_a, drug_b) pairs to look up
    const pairs = [];   // { drug_a, drug_b, brandA, brandB, ingA, ingB }
    for (let i = 0; i < perBrand.length; i++) {
      for (let j = i + 1; j < perBrand.length; j++) {
        for (const a of perBrand[i].ings) {
          if (!a.ddinter_name) continue;
          for (const b of perBrand[j].ings) {
            if (!b.ddinter_name || a.ddinter_name === b.ddinter_name) continue;
            const [da, db] = a.ddinter_name < b.ddinter_name
              ? [a.ddinter_name, b.ddinter_name]
              : [b.ddinter_name, a.ddinter_name];
            pairs.push({
              drug_a: da, drug_b: db,
              brandA: perBrand[i].brand, brandB: perBrand[j].brand,
              ingA: a.ingredient, ingB: b.ingredient,
            });
          }
        }
      }
    }

    if (pairs.length) {
      // Batched lookup: send array of (drug_a, drug_b) to interactions table
      const drugAs = pairs.map(p => p.drug_a);
      const drugBs = pairs.map(p => p.drug_b);
      const { rows } = await this.pool.query(
        `SELECT drug_a, drug_b, severity
           FROM rx.interactions
          WHERE (drug_a, drug_b) IN (
            SELECT * FROM unnest($1::text[], $2::text[])
          )`,
        [drugAs, drugBs]
      );
      const sevMap = new Map(rows.map(r => [r.drug_a + '|' + r.drug_b, r.severity]));
      for (const p of pairs) {
        const sev = sevMap.get(p.drug_a + '|' + p.drug_b);
        if (sev) {
          result.interactions.push({
            severity: sev,
            brand_a: p.brandA, brand_b: p.brandB,
            ingredient_a: p.ingA, ingredient_b: p.ingB,
            drug_a: p.drug_a, drug_b: p.drug_b,
          });
          result.severity_summary[sev] = (result.severity_summary[sev] || 0) + 1;
        }
      }
      // Sort by severity Major > Moderate > Minor > Unknown
      const rank = { Major: 0, Moderate: 1, Minor: 2, Unknown: 3 };
      result.interactions.sort((a, b) => rank[a.severity] - rank[b.severity]);
    }

    return result;
  }
}

module.exports = { InteractionEngine, normalizeToDDInter, brandFamily };
