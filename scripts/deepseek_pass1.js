/**
 * Pass 1: DeepSeek ingredient lookup for 133k missing medicines.
 * Runs concurrent workers for maximum throughput.
 *
 * - Reads new_medicines_to_scrape.json
 * - Batches 50 medicines per call
 * - Runs N concurrent workers (default 5, backs off on 429)
 * - Resume-safe via .pass1_progress.json
 *
 * Run: node scripts/deepseek_pass1.js [--limit N] [--workers N]
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', 'backend', '.env') });

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const INPUT_FILE = path.join(DATA_DIR, 'new_medicines_to_scrape.json');
const KNOWN_FILE = path.join(DATA_DIR, 'pass1_known.json');
const UNKNOWN_FILE = path.join(DATA_DIR, 'pass1_unknown.json');
const PROGRESS_FILE = path.join(DATA_DIR, '.pass1_progress.json');

const args = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const LIMIT = parseInt(getArg('--limit', '0'), 10);
const BATCH_SIZE = 50;
const MAX_WORKERS = parseInt(getArg('--workers', '5'), 10);
const MAX_RETRIES = 4;

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY not set in backend/.env');
  process.exit(1);
}

// ---- Brand name from URL ----
function brandFromUrl(url) {
  const slug = url.split('/drugs/')[1] || '';
  return slug.replace(/-\d+$/, '').replace(/-/g, ' ').trim();
}

// ---- DeepSeek API call ----
function deepseekCall(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 2000,
    });

    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
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
          resolve(json.choices?.[0]?.message?.content || '');
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

// ---- Process one batch with retry/backoff ----
let activeWorkers = MAX_WORKERS;

async function processBatch(brands, retries = 0) {
  const list = brands.map((m, i) => `${i + 1}. ${m}`).join('\n');
  const prompt = `You are a pharmacology expert specializing in Indian medicines.

For each medicine below, return its active ingredients.
If you are NOT confident about a medicine's ingredients, return "UNKNOWN" for that medicine.
Do NOT guess. Only return ingredients you are certain about.

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
    const response = await deepseekCall(prompt);
    const clean = response.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');
    return JSON.parse(clean);
  } catch (e) {
    if (e.code === 429) {
      // Back off and reduce concurrency
      activeWorkers = Math.max(1, activeWorkers - 1);
      const wait = Math.pow(2, retries) * 5000;
      process.stdout.write(`\n  ⚠ 429 — reducing to ${activeWorkers} workers, waiting ${wait/1000}s `);
      await new Promise(r => setTimeout(r, wait));
      if (retries < MAX_RETRIES) return processBatch(brands, retries + 1);
    }
    if (retries < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 3000));
      return processBatch(brands, retries + 1);
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

// ---- Progress display ----
function printProgress(done, total, knownCount, unknownCount, t0, workers) {
  const pct = ((done / total) * 100).toFixed(1);
  const elapsed = (Date.now() - t0) / 1000;
  const rate = done / elapsed;
  const eta = rate > 0 ? ((total - done) / rate / 60).toFixed(0) : '?';
  process.stdout.write(
    `\r  Progress: ${done}/${total} (${pct}%) | known:${knownCount} unknown:${unknownCount} | workers:${workers} | ETA:${eta}min  `
  );
}

// ---- Main ----
(async () => {
  const allUrls = JSON.parse(fs.readFileSync(INPUT_FILE));
  const target = LIMIT > 0 ? allUrls.slice(0, LIMIT) : allUrls;
  const processed = loadProgress();
  const todo = target.filter(url => !processed.has(url));
  const totalBatches = Math.ceil(todo.length / BATCH_SIZE);

  // Split into batches upfront
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    batches.push(todo.slice(i, i + BATCH_SIZE));
  }

  console.log(`Total new medicines:  ${target.length.toLocaleString()}`);
  console.log(`Already processed:    ${processed.size.toLocaleString()}`);
  console.log(`To process:           ${todo.length.toLocaleString()} (${totalBatches} batches of ${BATCH_SIZE})`);
  console.log(`Concurrent workers:   ${MAX_WORKERS}`);
  console.log(`Est. time:            ~${((totalBatches / MAX_WORKERS) * 16 / 60).toFixed(0)} minutes\n`);

  const known = loadResults(KNOWN_FILE);
  const unknown = loadResults(UNKNOWN_FILE);
  let knownCount = known.length;
  let unknownCount = unknown.length;
  let failedCount = 0;
  let batchIndex = 0;
  const t0 = Date.now();
  const writeLock = { locked: false, queue: [] };

  // ---- Safe write (prevent concurrent file writes) ----
  function safeWrite() {
    fs.writeFileSync(KNOWN_FILE, JSON.stringify(known, null, 2));
    fs.writeFileSync(UNKNOWN_FILE, JSON.stringify(unknown, null, 2));
    saveProgress(processed);
  }

  // ---- Worker function ----
  async function worker(workerId) {
    while (batchIndex < batches.length) {
      const myIndex = batchIndex++;
      if (myIndex >= batches.length) break;

      const batch = batches[myIndex];
      const brands = batch.map(brandFromUrl);

      try {
        const results = await processBatch(brands);

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          const url = batch[j];
          if (!result || result.ingredients === 'UNKNOWN' || !Array.isArray(result.ingredients) || !result.ingredients.length) {
            unknown.push({ url, brand: brands[j] });
            unknownCount++;
          } else {
            known.push({
              url,
              brand: brands[j],
              ingredients: result.ingredients.map(s => s.toLowerCase().trim()),
            });
            knownCount++;
          }
          processed.add(url);
        }

        // Save every 10 batches
        if (myIndex % 10 === 0) safeWrite();

      } catch (e) {
        failedCount += batch.length;
      }

      printProgress(processed.size - (target.length - todo.length), todo.length, knownCount, unknownCount, t0, activeWorkers);
    }
  }

  // ---- Launch workers ----
  console.log(`Starting ${MAX_WORKERS} concurrent workers...\n`);
  const workers = Array.from({ length: MAX_WORKERS }, (_, i) => worker(i));
  await Promise.all(workers);

  // Final save
  safeWrite();

  const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  const total = knownCount + unknownCount;

  console.log(`\n\n✅ Done in ${elapsed} minutes`);
  console.log(`\n📊 Pass 1 Results:`);
  console.log(`  ┌──────────────────────────────────────`);
  console.log(`  │ Total processed:  ${total.toLocaleString()}`);
  console.log(`  │ Known (DeepSeek): ${knownCount.toLocaleString()} (${total > 0 ? ((knownCount/total)*100).toFixed(1) : 0}%)`);
  console.log(`  │ Unknown:          ${unknownCount.toLocaleString()} (${total > 0 ? ((unknownCount/total)*100).toFixed(1) : 0}%)`);
  console.log(`  │ Failed:           ${failedCount.toLocaleString()}`);
  console.log(`  └──────────────────────────────────────`);

  const groundedPrompts = Math.ceil(unknownCount / BATCH_SIZE);
  console.log(`\n📌 Pass 2 (Gemini grounding for ${unknownCount.toLocaleString()} unknowns):`);
  if (groundedPrompts === 0) {
    console.log(`  ✅ No unknowns — skip Pass 2!`);
  } else if (groundedPrompts <= 1500) {
    console.log(`  ✅ ${groundedPrompts} prompts — fits in free tier ($0, 1 day)`);
  } else {
    const days = Math.ceil(groundedPrompts / 1500);
    const cost = ((groundedPrompts / 1000) * 35).toFixed(2);
    console.log(`  ${groundedPrompts} prompts → free in ${days} days OR $${cost} paid`);
  }
  console.log(`\n  Run: node scripts/gemini_pass2.js`);
})();
