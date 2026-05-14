/**
 * Express server for the drug-interaction backend.
 *   GET  /api/health
 *   GET  /api/search?q=...
 *   POST /api/check        body: { brands: [...] }
 *
 * Run:
 *   npm start             # production
 *   npm run dev           # auto-reload on file changes
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const cors = require('cors');
const { InteractionEngine } = require('./src/engine');
const { Gap1Cache } = require('./src/gap1Cache');
const { Gap3Cache } = require('./src/gap3Cache');
const { GeminiEnricher } = require('./src/gemini');

const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
const REPO_DATA_DIR = path.resolve(__dirname, '..', 'data');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Download dataset files from HF via direct HTTPS (resolve URL bypasses LFS pointer issue)
const HF_DATASET_FILES = [
  'interactions.csv',
  '1mg_medicines_normalized.csv',
  'canonical_generics.csv',
  'gap1_cache.csv',
  'gap3_cache.csv',
];
const HF_BASE = 'https://huggingface.co/datasets/amulyakh/drug-interactions-data/resolve/main';
const MIN_BYTES = 10_000; // anything smaller is treated as a stale stub and re-downloaded

function downloadOne(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        const next = new URL(res.headers.location, url).toString();
        return downloadOne(next, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    });
    req.on('error', err => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

async function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of HF_DATASET_FILES) {
    const dest = path.join(DATA_DIR, f);
    const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (existing >= MIN_BYTES) {
      console.log(`[startup] ${f} already present (${existing} bytes)`);
      continue;
    }
    if (existing > 0) {
      console.log(`[startup] ${f} is stub (${existing} bytes) — re-downloading`);
      fs.unlinkSync(dest);
    }
    console.log(`[startup] downloading ${f}...`);
    await downloadOne(`${HF_BASE}/${f}`, dest);
    const size = fs.statSync(dest).size;
    console.log(`[startup] ${f} → ${size} bytes`);
  }
}

// First-boot bootstrap: if DATA_DIR points at an empty persistent disk,
// copy the read-only CSVs shipped in the repo into it.
if (DATA_DIR !== REPO_DATA_DIR && fs.existsSync(REPO_DATA_DIR)) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of fs.readdirSync(REPO_DATA_DIR)) {
    const src = path.join(REPO_DATA_DIR, f);
    const dst = path.join(DATA_DIR, f);
    if (!fs.existsSync(dst) && fs.statSync(src).isFile()) {
      fs.copyFileSync(src, dst);
      console.log('[bootstrap] copied', f, '→', DATA_DIR);
    }
  }
}

console.log('[startup] GEMINI_API_KEY:', GEMINI_API_KEY ? '✓ set' : '✗ not set');

const app = express();
app.use(cors());
app.use(express.json());

let engine;
(async () => {
  await ensureData();
  console.log('Loading interaction engine from', DATA_DIR);
  engine = new InteractionEngine(DATA_DIR);
  engine.load();

  const gap1Cache = new Gap1Cache();
  const gap3Cache = new Gap3Cache();

  let geminiEnricher = null;
  if (GEMINI_API_KEY) {
    geminiEnricher = new GeminiEnricher(GEMINI_API_KEY);
    console.log('[gap1] Gemini enricher active');
  } else {
    console.log('[gap1] No GEMINI_API_KEY — Gap 1 fallback disabled (set env var to enable)');
  }

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      medicines: engine.medicines.length,
      pairs: engine.pairIndex.size,
      ddinter_drugs: engine.knownDDInterDrugs.size,
      gap1_cached: gap1Cache.medicines.size,
      gap3_cached: gap3Cache.ingredients.size,
      gemini_active: !!geminiEnricher,
    });
  });

  app.get('/api/search', (req, res) => {
    const q = String(req.query.q || '');
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    res.json({ results: engine.search(q, limit) });
  });

  app.post('/api/check', async (req, res) => {
    const brands = Array.isArray(req.body && req.body.brands) ? req.body.brands : null;
    if (!brands) return res.status(400).json({ error: 'Body must be { brands: [...] }' });

    console.log('[/api/check] brands:', brands, 'geminiEnricher:', !!geminiEnricher);

    try {
      if (geminiEnricher) {
        console.log('[/api/check] using Gap 1 & Gap 3 fallback...');
        const result = await engine.checkWithGap1Fallback(brands, gap1Cache, geminiEnricher, gap3Cache);
        console.log('[/api/check] result unresolved:', result.unresolved_brands);
        return res.json(result);
      }
      console.log('[/api/check] no geminiEnricher, using plain check');
      res.json(engine.check(brands));
    } catch (e) {
      console.error('/api/check error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`✓ Backend listening on http://localhost:${PORT}`);
  });
})();
