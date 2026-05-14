/**
 * Enrich 2,037 new ingredients not in canonical_generics.csv.
 *
 * For each new ingredient, asks Gemini:
 * "What are the top 15-20 drugs this interacts with?"
 * Appends results to data/gap5_cache.csv.
 *
 * Resume-safe via .enrich_new_progress.json
 *
 * Run: node scripts/enrich_new_ingredients.js [--limit N] [--workers N]
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', 'backend', '.env') });

const fs = require('fs');
const path = require('path');
const https = require('https');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'gap5_cache.csv');
const PROGRESS_FILE = path.join(DATA_DIR, '.enrich_new_progress.json');
const HEADERS = ['drug_a', 'drug_b', 'severity', 'clinical_effect', 'confidence', 'created_at'];

const args = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const LIMIT = parseInt(getArg('--limit', '0'), 10);
const MAX_WORKERS = parseInt(getArg('--workers', '10'), 10);
const DELAY_MS = 500;
const MAX_RETRIES = 4;

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not set in backend/.env');
  process.exit(1);
}

// ---- Collect 2,037 new ingredients ----
function getNewIngredients() {
  const p1 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pass1_known.json')));
  const p2 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pass2_known.json')));
  const all = [...p1, ...p2];

  const existing = parse(fs.readFileSync(path.join(DATA_DIR, 'canonical_generics.csv')), { columns: true });
  const knownIngredients = new Set(existing.map(r => r.ingredient.toLowerCase().trim()));

  const newIngredients = new Set();
  for (const m of all) {
    for (const ing of m.ingredients) {
      const norm = ing.toLowerCase().trim();
      if (!knownIngredients.has(norm)) newIngredients.add(norm);
    }
  }
  return [...newIngredients];
}

// ---- Load already enriched ingredients from cache ----
function loadEnrichedIngredients() {
  if (!fs.existsSync(CACHE_FILE)) return new Set();
  const raw = fs.readFileSync(CACHE_FILE);
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  const enriched = new Set();
  for (const r of rows) {
    enriched.add(r.drug_a.toLowerCase().trim());
    enriched.add(r.drug_b.toLowerCase().trim());
  }
  return enriched;
}

// ---- Load progress ----
function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(PROGRESS_FILE))); } catch { return new Set(); }
}
function saveProgress(processed) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify([...processed]));
}

// ---- Gemini API call ----
function geminiCall(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 1.0, maxOutputTokens: 2000 },
    });

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(Object.assign(new Error('Rate limited'), { code: 429 }));
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          resolve(json.candidates?.[0]?.content?.parts?.[0]?.text || '');
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', reject);
    setTimeout(() => req.destroy(new Error('Timeout')), 60000);
    req.write(body);
    req.end();
  });
}

// ---- Enrich one ingredient ----
async function enrichIngredient(ingredient, retries = 0) {
  const prompt = `You are a clinical pharmacology expert.

For the drug "${ingredient}", list its top 15-20 clinically significant drug interactions (Major/Moderate/Minor only, skip Safe).

Return ONLY valid JSON array, no markdown:
[
  {
    "drug_b": "<interacting drug name>",
    "severity": "Major|Moderate|Minor",
    "clinical_effect": "one concise sentence (15-30 words) describing the main risk"
  }
]

Rules:
- drug_b must be a generic drug name (not brand name)
- Only include interactions with clear clinical significance
- clinical_effect must be specific and actionable`;

  try {
    const response = await geminiCall(prompt);
    const clean = response.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');
    return JSON.parse(clean);
  } catch (e) {
    if (e.code === 429) {
      const wait = Math.pow(2, retries) * 10000;
      await new Promise(r => setTimeout(r, wait));
      if (retries < MAX_RETRIES) return enrichIngredient(ingredient, retries + 1);
    }
    if (retries < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 3000));
      return enrichIngredient(ingredient, retries + 1);
    }
    throw e;
  }
}

// ---- Append rows to cache ----
function appendToCache(rows) {
  const csv = stringify(rows, { header: false, columns: HEADERS });
  fs.appendFileSync(CACHE_FILE, csv);
}

// ---- Main ----
(async () => {
  console.log('Loading new ingredients...');
  const allIngredients = getNewIngredients();
  const enrichedIngredients = loadEnrichedIngredients();
  const processed = loadProgress();

  const target = LIMIT > 0 ? allIngredients.slice(0, LIMIT) : allIngredients;
  const todo = target.filter(ing => !processed.has(ing) && !enrichedIngredients.has(ing));

  console.log(`New ingredients total:    ${target.length.toLocaleString()}`);
  console.log(`Already in cache:         ${(target.length - todo.length).toLocaleString()}`);
  console.log(`To enrich now:            ${todo.length.toLocaleString()}`);
  console.log(`Workers:                  ${MAX_WORKERS}`);
  console.log(`Est. time:                ~${Math.ceil(todo.length / MAX_WORKERS * 3 / 60)} minutes`);
  console.log(`Est. cost:                ~$${(todo.length * 20 * 0.0001).toFixed(2)}\n`);

  let ingIndex = 0;
  let totalRows = 0;
  let failed = 0;
  const t0 = Date.now();

  function printProgress() {
    const done = processed.size;
    const pct = todo.length > 0 ? ((done / todo.length) * 100).toFixed(1) : 100;
    const elapsed = (Date.now() - t0) / 1000;
    const rate = done / elapsed;
    const eta = rate > 0 ? ((todo.length - done) / rate / 60).toFixed(0) : '?';
    process.stdout.write(`\r  Progress: ${done}/${todo.length} (${pct}%) | rows:${totalRows} failed:${failed} | ETA:${eta}min  `);
  }

  async function worker() {
    while (ingIndex < todo.length) {
      const myIndex = ingIndex++;
      if (myIndex >= todo.length) break;
      const ingredient = todo[myIndex];

      try {
        const results = await enrichIngredient(ingredient);
        const now = new Date().toISOString().split('T')[0];
        const rows = (results || [])
          .filter(r => r.drug_b && r.severity && r.severity !== 'Safe')
          .map(r => ({
            drug_a: ingredient,
            drug_b: r.drug_b.toLowerCase().trim(),
            severity: r.severity,
            clinical_effect: r.clinical_effect || '',
            confidence: 1,
            created_at: now,
          }));

        if (rows.length > 0) appendToCache(rows);
        totalRows += rows.length;
        processed.add(ingredient);

        if (myIndex % 20 === 0) saveProgress(processed);
      } catch (e) {
        failed++;
      }

      printProgress();
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`Starting ${MAX_WORKERS} parallel workers...\n`);
  await Promise.all(Array.from({ length: MAX_WORKERS }, () => worker()));

  saveProgress(processed);

  const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log(`\n\n✅ Done in ${elapsed} minutes`);
  console.log(`\n📊 Enrichment Results:`);
  console.log(`  ┌──────────────────────────────────────`);
  console.log(`  │ Ingredients enriched: ${processed.size.toLocaleString()}`);
  console.log(`  │ New rows added:       ${totalRows.toLocaleString()}`);
  console.log(`  │ Failed:               ${failed.toLocaleString()}`);
  console.log(`  └──────────────────────────────────────`);
  console.log(`\nNext step → Load everything into database`);
  console.log(`  Run: node scripts/load_into_db.js`);
})();
