/**
 * Gap 3 batch enrichment.
 *
 * Reads data/gap3_missing_ingredients.json (output of extract_missing_ingredients.py),
 * sends them to Gemini in batches of 10, asks for interactions against the
 * COMMON_DRUGS list, and appends rows to data/gap3_cache.csv.
 *
 * Resume-safe: skips ingredients that already have rows in gap3_cache.csv.
 *
 * Run: node scripts/enrich_gap3.js [--limit N] [--batch-size N]
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', 'backend', '.env') });

const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const INPUT_FILE = path.join(DATA_DIR, 'gap3_missing_ingredients.json');
const CACHE_FILE = path.join(DATA_DIR, 'gap3_cache.csv');
const HEADERS = ['ingredient','drug_b','severity','side_effects','mechanism','clinical_action','confidence','created_at'];

// Common drugs to check interactions against (same list as gap1).
const COMMON_DRUGS = [
  'aspirin','paracetamol','ibuprofen','warfarin','metformin','atorvastatin',
  'amlodipine','losartan','omeprazole','pantoprazole','amoxicillin','azithromycin',
  'ciprofloxacin','metronidazole','prednisolone','dexamethasone','insulin',
  'digoxin','furosemide','spironolactone','atenolol','metoprolol','ramipril',
  'clopidogrel','rosuvastatin','gabapentin','alprazolam','diazepam',
  'sertraline','fluoxetine','amitriptyline','tramadol','codeine','morphine',
  'phenytoin','valproate','carbamazepine','rifampicin','isoniazid','ethambutol',
  'hydroxychloroquine','colchicine','allopurinol','methotrexate','cyclosporine',
  'tacrolimus','lithium','haloperidol','clozapine','olanzapine',
  'lorazepam','clonazepam','midazolam','zolpidem',
];

// ---- Args ----
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const LIMIT = parseInt(getArg('--limit', '0'), 10);  // 0 = no limit
const BATCH_SIZE = parseInt(getArg('--batch-size', '10'), 10);

// ---- Init Gemini ----
if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not set in backend/.env');
  process.exit(1);
}
const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = client.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

// ---- Load already-enriched ingredients from cache (resume support) ----
function loadEnrichedSet() {
  if (!fs.existsSync(CACHE_FILE)) {
    fs.writeFileSync(CACHE_FILE, HEADERS.join(',') + '\n');
    return new Set();
  }
  const raw = fs.readFileSync(CACHE_FILE);
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  return new Set(rows.map(r => r.ingredient));
}

// ---- Build prompt for batch ----
function buildPrompt(ingredients) {
  return `You are a clinical pharmacology expert. For each of these ingredients, list clinically significant interactions with drugs from the common-drug list.

Ingredients:
${ingredients.map((ing, i) => `${i + 1}. ${ing}`).join('\n')}

Common drug list:
${COMMON_DRUGS.join(', ')}

Return ONLY valid JSON, no markdown:
{
  "results": [
    {
      "ingredient": "<ingredient name as given>",
      "interactions": [
        {
          "drug": "<drug from common list>",
          "severity": "Major|Moderate|Minor",
          "side_effects": "<short clinical effect>",
          "mechanism": "<short pharmacology>",
          "clinical_action": "<what doctor should do>"
        }
      ]
    }
  ]
}

Rules:
- Skip Safe interactions; only return Major/Moderate/Minor.
- If an ingredient has no significant interactions with any common drug, return an empty interactions array.
- Be concise; one short sentence per field.
- Include every ingredient in the input, in the same order.`;
}

// ---- Process one batch (with retry/backoff on 429) ----
async function enrichBatch(ingredients) {
  const prompt = buildPrompt(ingredients);
  const backoffs = [30000, 60000, 90000];  // 30s, 60s, 90s
  let lastErr = null;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '');
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      const isRateLimit = /429|quota|rate.*limit/i.test(e.message || '');
      if (!isRateLimit || attempt === backoffs.length) throw e;
      const wait = backoffs[attempt];
      console.log(`\n  ⚠ rate limited, sleeping ${wait/1000}s before retry ${attempt + 1}/${backoffs.length}`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function rowsFromBatch(batchResult, now) {
  const rows = [];
  for (const r of batchResult.results || []) {
    const ing = r.ingredient;
    if (!ing) continue;
    const interactions = (r.interactions || []).filter(it => it.severity && it.severity !== 'Safe');
    if (interactions.length === 0) {
      // record that we checked this ingredient and found nothing
      rows.push({
        ingredient: ing.toLowerCase(),
        drug_b: '',
        severity: '',
        side_effects: '',
        mechanism: '',
        clinical_action: '',
        confidence: 1,
        created_at: now,
      });
      continue;
    }
    for (const it of interactions) {
      rows.push({
        ingredient: ing.toLowerCase(),
        drug_b: (it.drug || '').toLowerCase(),
        severity: it.severity,
        side_effects: it.side_effects || '',
        mechanism: it.mechanism || '',
        clinical_action: it.clinical_action || '',
        confidence: 1,
        created_at: now,
      });
    }
  }
  return rows;
}

function appendRows(rows) {
  const csv = stringify(rows, { header: false, columns: HEADERS });
  fs.appendFileSync(CACHE_FILE, csv);
}

// ---- Main ----
(async () => {
  const all = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf-8'));
  const enriched = loadEnrichedSet();
  const todo = all
    .map(x => x.ingredient)
    .filter(ing => !enriched.has(ing.toLowerCase()));

  const target = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;
  const totalBatches = Math.ceil(target.length / BATCH_SIZE);

  console.log(`Total missing: ${all.length}`);
  console.log(`Already enriched: ${enriched.size}`);
  console.log(`To enrich now: ${target.length} (${totalBatches} batches of ${BATCH_SIZE})`);
  console.log(`Cache file: ${CACHE_FILE}\n`);

  let done = 0, failed = 0, totalRows = 0;
  const t0 = Date.now();

  for (let i = 0; i < target.length; i += BATCH_SIZE) {
    const batch = target.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    process.stdout.write(`[${batchNum}/${totalBatches}] ${batch[0]} ... ${batch[batch.length - 1]} `);

    try {
      const result = await enrichBatch(batch);
      const now = new Date().toISOString().split('T')[0];
      const rows = rowsFromBatch(result, now);
      appendRows(rows);
      totalRows += rows.length;
      done += batch.length;
      console.log(`✓ +${rows.length} rows`);
    } catch (e) {
      failed += batch.length;
      console.log(`✗ ${e.message.split('\n')[0]}`);
    }

    // throttle to stay under 15 RPM free-tier limit (need >=4s between calls)
    await new Promise(r => setTimeout(r, 4500));
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s. ingredients=${done} failed=${failed} rows=${totalRows}`);
})();
