/**
 * Pass 2: Gemini with Google Search grounding for unknown medicines.
 *
 * - Reads pass1_unknown.json (15,740 medicines DeepSeek didn't know)
 * - Batches 50 per Gemini call with Search grounding enabled
 * - Saves results to pass2_known.json and pass2_unknown.json
 * - Resume-safe via .pass2_progress.json
 *
 * Cost: FREE (315 prompts fits within 1,500/day free tier)
 *
 * Run: node scripts/gemini_pass2.js [--limit N]
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', 'backend', '.env') });

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const INPUT_FILE = path.join(DATA_DIR, 'pass1_unknown.json');
const KNOWN_FILE = path.join(DATA_DIR, 'pass2_known.json');
const UNKNOWN_FILE = path.join(DATA_DIR, 'pass2_unknown.json');
const PROGRESS_FILE = path.join(DATA_DIR, '.pass2_progress.json');

const args = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const LIMIT = parseInt(getArg('--limit', '0'), 10);
const MAX_WORKERS = parseInt(getArg('--workers', '10'), 10);
const BATCH_SIZE = 50;
const DELAY_MS = 500; // Tier 1: 300 RPM — much faster
const MAX_RETRIES = 4;

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not set in backend/.env');
  process.exit(1);
}

// ---- Gemini API call with Search grounding ----
function geminiCall(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
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
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text);
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

// ---- Process one batch ----
async function processBatch(medicines, retries = 0) {
  const list = medicines.map((m, i) => `${i + 1}. ${m.brand}`).join('\n');

  const prompt = `You are a pharmacology expert. Use Google Search to find the active ingredients for each Indian medicine below.
If you cannot find reliable information for a medicine, return "UNKNOWN" for it.

Medicines:
${list}

Return ONLY valid JSON array, no markdown:
[
  {
    "medicine": "<exact name from input>",
    "ingredients": ["ingredient1", "ingredient2"] or "UNKNOWN"
  }
]`;

  try {
    const response = await geminiCall(prompt);
    const clean = response.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');
    return JSON.parse(clean);
  } catch (e) {
    if (e.code === 429) {
      const wait = Math.pow(2, retries) * 30000;
      console.log(`\n  ⚠ Rate limited, waiting ${wait/1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      if (retries < MAX_RETRIES) return processBatch(medicines, retries + 1);
    }
    if (retries < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, DELAY_MS * 2));
      return processBatch(medicines, retries + 1);
    }
    throw e;
  }
}

// ---- Load/save helpers ----
function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(PROGRESS_FILE))); } catch { return new Set(); }
}
function saveProgress(processed) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify([...processed]));
}
function loadResults(file) {
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file)); } catch { return []; }
}

// ---- Main ----
(async () => {
  const allMedicines = JSON.parse(fs.readFileSync(INPUT_FILE));
  const target = LIMIT > 0 ? allMedicines.slice(0, LIMIT) : allMedicines;
  const processed = loadProgress();
  const todo = target.filter(m => !processed.has(m.url));
  const totalBatches = Math.ceil(todo.length / BATCH_SIZE);

  console.log(`Total unknowns from Pass 1: ${target.length.toLocaleString()}`);
  console.log(`Already processed:          ${processed.size.toLocaleString()}`);
  console.log(`To process now:             ${todo.length.toLocaleString()} (${totalBatches} batches of ${BATCH_SIZE})`);
  console.log(`Est. time:                  ~${Math.ceil(totalBatches * DELAY_MS / 60000)} minutes`);
  console.log(`Cost:                       $0 (free tier)\n`);

  const known = loadResults(KNOWN_FILE);
  const unknown = loadResults(UNKNOWN_FILE);
  let knownCount = known.length;
  let unknownCount = unknown.length;
  let failedCount = 0;
  const t0 = Date.now();

  // Split into batches upfront
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    batches.push(todo.slice(i, i + BATCH_SIZE));
  }

  let batchIndex = 0;

  function printProgress() {
    const done = processed.size - (target.length - todo.length);
    const pct = ((done / todo.length) * 100).toFixed(1);
    const elapsed = (Date.now() - t0) / 1000;
    const rate = done / elapsed;
    const eta = rate > 0 ? ((todo.length - done) / rate / 60).toFixed(0) : '?';
    process.stdout.write(`\r  Progress: ${done}/${todo.length} (${pct}%) | known:${knownCount} unknown:${unknownCount} | ETA:${eta}min  `);
  }

  async function worker() {
    while (batchIndex < batches.length) {
      const myIndex = batchIndex++;
      if (myIndex >= batches.length) break;
      const batch = batches[myIndex];

      try {
        const results = await processBatch(batch);
        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          const med = batch[j];
          if (!result || result.ingredients === 'UNKNOWN' || !Array.isArray(result.ingredients) || !result.ingredients.length) {
            unknown.push({ url: med.url, brand: med.brand });
            unknownCount++;
          } else {
            known.push({
              url: med.url,
              brand: med.brand,
              ingredients: result.ingredients.map(s => s.toLowerCase().trim()),
            });
            knownCount++;
          }
          processed.add(med.url);
        }
        if (myIndex % 10 === 0) {
          fs.writeFileSync(KNOWN_FILE, JSON.stringify(known, null, 2));
          fs.writeFileSync(UNKNOWN_FILE, JSON.stringify(unknown, null, 2));
          saveProgress(processed);
        }
      } catch (e) {
        failedCount += batch.length;
      }
      printProgress();
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`Launching ${MAX_WORKERS} parallel workers...\n`);
  await Promise.all(Array.from({ length: MAX_WORKERS }, () => worker()));

  // Final save
  fs.writeFileSync(KNOWN_FILE, JSON.stringify(known, null, 2));
  fs.writeFileSync(UNKNOWN_FILE, JSON.stringify(unknown, null, 2));
  saveProgress(processed);

  const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  const total = knownCount + unknownCount;

  console.log(`\n✅ Pass 2 Done in ${elapsed} minutes`);
  console.log(`\n📊 Pass 2 Results:`);
  console.log(`  ┌──────────────────────────────────────`);
  console.log(`  │ Total processed:     ${total.toLocaleString()}`);
  console.log(`  │ Known (Gemini):      ${knownCount.toLocaleString()} (${total > 0 ? ((knownCount/total)*100).toFixed(1) : 0}%)`);
  console.log(`  │ Still unknown:       ${unknownCount.toLocaleString()} (${total > 0 ? ((unknownCount/total)*100).toFixed(1) : 0}%)`);
  console.log(`  │ Failed:              ${failedCount.toLocaleString()}`);
  console.log(`  └──────────────────────────────────────`);
  console.log(`\nNext step → Combine Pass 1 + Pass 2 results and enrich new ingredient pairs`);
  console.log(`  Run: node scripts/enrich_new_ingredients.js`);
})();
