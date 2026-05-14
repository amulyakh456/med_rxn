/**
 * Gap 5: DDInter pair enrichment (main clinical risk/effect only).
 *
 * Reads data/interactions.csv (DDInter 224,449 drug pairs with severity only),
 * sends them to Gemini in batches of 10, asks for main clinical risk/effect,
 * and appends rows to data/gap5_cache.csv.
 *
 * Resume-safe: skips pairs that already have rows in gap5_cache.csv.
 *
 * Run: node scripts/enrich_ddinter.js [--limit N] [--batch-size N]
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', 'backend', '.env') });

const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const INPUT_FILE = path.join(DATA_DIR, 'interactions.csv');
const CACHE_FILE = path.join(DATA_DIR, 'gap5_cache.csv');
const HEADERS = ['drug_a','drug_b','severity','clinical_effect','confidence','created_at'];

// ---- Args ----
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const LIMIT = parseInt(getArg('--limit', '0'), 10);  // 0 = no limit
const BATCH_SIZE = parseInt(getArg('--batch-size', '10'), 10);
const DELAY_MS = parseInt(getArg('--delay', '4500'), 10);
const CONCURRENCY = parseInt(getArg('--concurrency', '1'), 10);

// ---- Init Gemini ----
if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not set in backend/.env');
  process.exit(1);
}
const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = client.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

// ---- Load already-enriched pairs from cache (resume support) ----
function loadEnrichedSet() {
  if (!fs.existsSync(CACHE_FILE)) {
    fs.writeFileSync(CACHE_FILE, HEADERS.join(',') + '\n');
    return new Set();
  }
  const raw = fs.readFileSync(CACHE_FILE);
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  return new Set(rows.map(r => {
    const [a, b] = r.drug_a < r.drug_b ? [r.drug_a, r.drug_b] : [r.drug_b, r.drug_a];
    return `${a}|${b}`;
  }));
}

// ---- Process one batch (with retry/backoff on 429) ----
async function enrichBatch(pairs) {
  const pairsList = pairs.map((p, i) => `${i + 1}. ${p.drug_a} + ${p.drug_b}`).join('\n');
  const prompt = `You are a clinical pharmacology expert. For each drug pair, determine severity and main clinical risk/effect.

Drug pairs:
${pairsList}

Return ONLY valid JSON array with no markdown:
[
  {
    "drug_a": "<first drug>",
    "drug_b": "<second drug>",
    "severity": "Major|Moderate|Minor|Safe",
    "clinical_effect": "one sentence main risk/effect"
  }
]

Rules:
- Skip Safe interactions; include Major/Moderate/Minor only.
- clinical_effect must be one concise sentence (15-30 words max).
- Include every pair in the input, in the same order.`;

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
  for (const r of batchResult || []) {
    const dA = r.drug_a;
    const dB = r.drug_b;
    if (!dA || !dB) continue;
    if (r.severity === 'Safe' || !r.severity) continue;
    rows.push({
      drug_a: dA.toLowerCase(),
      drug_b: dB.toLowerCase(),
      severity: r.severity,
      clinical_effect: r.clinical_effect || '',
      confidence: 1,
      created_at: now,
    });
  }
  return rows;
}

function appendRows(rows) {
  const csv = stringify(rows, { header: false, columns: HEADERS });
  fs.appendFileSync(CACHE_FILE, csv);
}

// ---- Main ----
(async () => {
  const raw = fs.readFileSync(INPUT_FILE);
  const all = parse(raw, { columns: true, skip_empty_lines: true });
  const enriched = loadEnrichedSet();

  const todo = all.filter(r => {
    const [a, b] = r.drug_a < r.drug_b ? [r.drug_a, r.drug_b] : [r.drug_b, r.drug_a];
    return !enriched.has(`${a}|${b}`);
  });

  const target = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;
  const totalBatches = Math.ceil(target.length / BATCH_SIZE);

  console.log(`Total pairs in DDInter: ${all.length}`);
  console.log(`Already enriched: ${enriched.size}`);
  console.log(`To enrich now: ${target.length} (${totalBatches} batches of ${BATCH_SIZE})`);
  console.log(`Cache file: ${CACHE_FILE}\n`);

  let done = 0, failed = 0, totalRows = 0;
  const t0 = Date.now();

  // Build array of all batches
  const batches = [];
  for (let i = 0; i < target.length; i += BATCH_SIZE) {
    batches.push({ pairs: target.slice(i, i + BATCH_SIZE), num: Math.floor(i / BATCH_SIZE) + 1 });
  }

  // Process with concurrency limit
  let batchIdx = 0;
  async function worker() {
    while (batchIdx < batches.length) {
      const { pairs, num } = batches[batchIdx++];
      try {
        const result = await enrichBatch(pairs);
        const now = new Date().toISOString().split('T')[0];
        const rows = rowsFromBatch(result, now);
        appendRows(rows);
        totalRows += rows.length;
        done += pairs.length;
        console.log(`[${num}/${totalBatches}] ✓ +${rows.length} rows`);
      } catch (e) {
        failed += pairs.length;
        console.log(`[${num}/${totalBatches}] ✗ ${e.message.split('\n')[0]}`);
      }
      if (DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s. pairs=${done} failed=${failed} rows=${totalRows}`);
})();
