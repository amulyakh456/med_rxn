# Drug Interaction Checker – Technical Documentation

## Project Overview

**Drug Interaction POC** is an end-to-end drug-interaction checker for Indian medicine prescriptions. It matches brand names against a curated database of drug-drug interactions, flags unsafe combinations, and provides clinical severity and side-effect details. Built for integration with recordrx's tech stack: Node.js backend, React frontend, Postgres/Supabase ready.

**Deployment Model:**
- Backend: Hugging Face Spaces (Docker, free tier)
- Frontend: Render (static site, free tier)
- Data: HF Dataset (public, large files)
- Enrichment: Gemini API (pay-per-call, ~₹0.06 per new brand)

---

## Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    React Frontend (Render)                  │
│  - Prescription UI (recordrx-styled)                       │
│  - Medicine search (autocomplete, 252K SKUs)               │
│  - Interaction warnings (color-coded severity)             │
│  - Real-time recomputation on add/remove                   │
└────────────────────────┬────────────────────────────────────┘
                         │
              VITE_API_BASE (proxy /api/*)
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│           Express Backend (HF Spaces Docker)                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ InteractionEngine (in-memory, loads at startup)     │   │
│  │ - ~252K 1mg.com brand SKUs                          │   │
│  │ - ~224K DDInter drug-drug pairs (with enrichment)  │   │
│  │ - Normalized brand→generic mapping                  │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Gap Handlers (resume-safe, cache-backed)            │   │
│  │ - Gap 1: Gemini fallback for unknown brands         │   │
│  │ - Gap 3: Pre-enriched missing ingredients vs common │   │
│  │ - Gap 5: Clinical effect text for all pairs         │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Routes                                              │   │
│  │ - GET  /api/health                                  │   │
│  │ - GET  /api/search?q=...                            │   │
│  │ - POST /api/check  body: { brands: [...] }          │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         │              │               │
         │              │               │
    (cache)       (data download)   (Gemini API)
         │              │               │
         ▼              ▼               ▼
    gap*Cache.csv  HF Dataset (CSVs)  Gemini 2.5 Flash
```

---

## Data Pipeline

### Sources

1. **1mg.com Medicines** (252,997 SKUs)
   - Snapshot: 2025-10-22
   - Source: Web scrape → CSV
   - Normalized salt names (paracetamol → acetaminophen)
   - Deduped by active ingredients

2. **DDInter 2.0** (14 ATC files)
   - ~224,449 unique drug-drug pairs
   - Severity: Major / Moderate / Minor / Unknown
   - Source: Kaggle dataset
   - Pre-processed to CSV

3. **Gemini Enrichment** (on-demand + pre-cached)
   - Cost: ~₹0.06 per new brand (Gap 1), ~₹0.04 per ingredient (Gap 3)
   - Model: gemini-2.5-flash-lite (3-6x cheaper than standard)
   - Caching: Forever (cache CSVs prevent re-calls)

### Data Gaps and Solutions

#### Gap 1: Unknown Brand Names
**Problem:** User enters a brand name not in 1mg.com catalog (niche regional products, private labels, etc.)

**Solution:** Runtime Gemini fallback
- Prompt: "Is '{brand}' a real Indian medicine? If so, extract active ingredients and check against these common drugs: [list]"
- Acceptance criteria: `confidence >= 0.5 AND active_ingredients.length > 0`
- Override `is_real_medicine=false` if data is usable
- Result: cached in `gap1Cache.medicines` (in-memory, ephemeral on HF free tier)
- Cost: ~₹0.06 per new brand, expected 0–5 per week (~₹0–0.30/week)

**Example:** "kojiclar-h" (derma topical)
- Gemini identified: Kojic acid
- Matched against common drugs: None found
- Status: Resolved as real medicine with confidence 0.6, no interactions

#### Gap 3: Missing Ingredient Interactions
**Problem:** 1,301 Indian drug ingredients not in DDInter; engine skips them silently.

**Solution:** Pre-enriched batch cache
- Ran Gemini once to check 1,301 missing ingredients against 54 common drugs
- Generated `gap3Cache.csv` (8.2MB, all done upfront)
- Cost: ~₹52 one-time
- Benefit: Zero cost for production checks, no Gemini calls for missing ingredients

**Data included:** Serratiopeptidase, Domperidone, Nimesulide, Aceclofenac, Pseudoephedrine, etc.

**Update cadence:** ~5 new ingredients/week → re-run script, append to cache (~₹0.20/week)

#### Gap 5: Clinical Effect Text
**Problem:** DDInter provides severity only (Major/Moderate/Minor); no clinical management text.

**Solution:** Pre-generated enrichment via Gemini
- Ran one-time batch on all 224K pairs
- Prompt: "For [Drug A] + [Drug B], what is the main clinical risk/effect?"
- Added `clinical_effect` field to each pair (text)
- Cost: ~₹96 one-time
- Coverage: 99.1% of pairs (some pairs unsupported by Gemini)

**False positives filtered:** 17,922 rows with contradictory severity + text saying "no significant interaction"
- Regex filter: `/no.*significant.*interaction|not.*expected.*to.*interact/i`
- Applied at engine load time, removed from memory index

---

## Technology Stack

### Backend

- **Runtime:** Node.js 20
- **Framework:** Express.js
- **Data Format:** CSV (in-memory at startup)
- **Search:** Linear scan + trie-like prefix matching
- **API Client:** Gemini SDK (`@google/generative-ai`)
- **Environment:** Containerized (Docker)

**Key Files:**
- `backend/server.js` – Express app, async startup, data download from HF Dataset
- `backend/src/engine.js` – InteractionEngine class, DDInter load, normalization, gap handling
- `backend/src/gap1Cache.js` – In-memory cache for Gemini-enriched brands
- `backend/src/gap3Cache.js` – Pre-cached missing ingredient interactions
- `backend/src/gemini.js` – GeminiEnricher class, prompt engineering

### Frontend

- **Framework:** React 18 (Vite)
- **Styling:** Tailwind CSS
- **Components:** Modal (search), InteractionPanel (color-coded warnings)
- **API:** Relative URLs (proxied to backend via Vite dev server, absolute URLs in prod)

**Key Files:**
- `frontend/src/App.jsx` – Prescription table, add/remove medicines
- `frontend/src/components/InteractionPanel.jsx` – Collapsible warnings by severity
- `frontend/src/components/MedicineModal.jsx` – SKU search with autocomplete

### Deployment

- **Backend:** Hugging Face Spaces (Docker SDK, port 7860, free tier)
- **Frontend:** Render (static site, Node.js build, free tier)
- **Data:** HF Dataset (public, CDN-backed, fast downloads)
- **CI/CD:** Manual git push (no GitHub Actions)

---

## API Contract

### `GET /api/health`

Returns engine status and cache sizes.

**Response:**
```json
{
  "status": "ok",
  "medicines": 252997,
  "pairs": 224449,
  "ddinter_drugs": 4521,
  "gap1_cached": 15,
  "gap3_cached": 1301,
  "gemini_active": true
}
```

### `GET /api/search?q=cro&limit=10`

Search medicines by partial brand name.

**Query:**
- `q` – Search term (prefix match, case-insensitive)
- `limit` – Max results (default 10, capped at 50)

**Response:**
```json
{
  "results": [
    { "brand": "Crocin 500", "generic": "Paracetamol", "strength": "500 mg" },
    { "brand": "Crocin 650", "generic": "Paracetamol", "strength": "650 mg" }
  ]
}
```

### `POST /api/check`

Check a prescription for interactions.

**Body:**
```json
{
  "brands": ["Crocin 500", "Warf 5"]
}
```

**Response:**
```json
{
  "unresolved_brands": [],
  "medicines": [
    { "brand": "Crocin 500", "generic": "Paracetamol", "strength": "500 mg" },
    { "brand": "Warf 5", "generic": "Warfarin", "strength": "5 mg" }
  ],
  "interactions": [
    {
      "drug_a": "Paracetamol",
      "drug_b": "Warfarin",
      "severity": "Major",
      "clinical_effect": "Increased risk of gastrointestinal bleeding",
      "side_effects": "Bleeding, bruising, GI upset",
      "mechanism": "Additive anticoagulant effect"
    }
  ]
}
```

**Fields:**
- `unresolved_brands` – Brands that couldn't be mapped (Gap 1 disabled or failed)
- `medicines` – Matched medicines with generics
- `interactions` – All pairwise interactions (sorted by severity)

---

## Startup Flow (HF Spaces)

1. **Docker build** (`docker build .`)
   - Install Node.js 20
   - Copy `backend/package.json`, run `npm install --production`
   - Copy `backend/` source

2. **Container start** (`CMD ["node", "server.js"]`)
   - Env: `PORT=7860`, `DATA_DIR=/app/data`
   - Server reads `ensureData()`:
     - If `/app/data/*.csv` missing, clone HF Dataset: `git clone https://huggingface.co/datasets/amulyakh/drug-interactions-data /app/data`
     - Copy required CSVs to `/app/data`
   - Load `InteractionEngine(DATA_DIR)`:
     - Read `interactions.csv`, `1mg_medicines_normalized.csv`, `canonical_generics.csv`
     - Build in-memory trie, pair index, DDInter drug set
     - Load `gap3Cache.csv`, `gap1Cache.csv` (if present)
   - Init `GeminiEnricher` (if `GEMINI_API_KEY` env var set)
   - Start Express on `:7860`

3. **First request** (e.g., `/api/check`)
   - Medicine lookup: trie → normalized brand → generic
   - Pair lookup: hash index `(generic_a, generic_b)` → severity, clinical_effect
   - Gap 1: if brand not found and Gemini active, call Gemini (cached)
   - Gap 3: if ingredient missing, check pre-cached results
   - Return response

---

## Deployment Instructions

### Backend (HF Spaces)

1. Create Space at https://huggingface.co/spaces
   - SDK: Docker
   - Name: `drug-interactions-api`

2. Push code:
   ```bash
   git clone https://huggingface.co/spaces/amulyakh/drug-interactions-api /tmp/hf-space
   cp Dockerfile /tmp/hf-space/
   cp backend/src backend/package* /tmp/hf-space/backend/
   cd /tmp/hf-space
   git add .
   git commit -m "Initial backend"
   git push
   ```

3. Space auto-builds and deploys (5–10 min)

4. Add secrets:
   - Go to Space Settings → Variables and secrets
   - `GEMINI_API_KEY` = your Gemini API key

5. Test:
   ```bash
   curl https://amulyakh-drug-interactions-api.hf.space/api/health
   ```

### Data (HF Dataset)

1. Create Dataset at https://huggingface.co/new-dataset
   - Name: `drug-interactions-data`
   - Visibility: Public

2. Upload 3 CSVs via web UI:
   - `interactions.csv`
   - `1mg_medicines_normalized.csv`
   - `canonical_generics.csv`

### Frontend (Render)

1. Update `render.yaml`:
   ```yaml
   services:
     - type: web
       name: drug-interactions-ui
       runtime: static
       rootDir: frontend
       buildCommand: npm install && npm run build
       staticPublishPath: ./dist
       envVars:
         - key: VITE_API_BASE
           value: https://amulyakh-drug-interactions-api.hf.space
   ```

2. Push to GitHub (`med_rxn` repo)

3. Deploy on Render:
   - https://render.com/dashboard
   - Blueprint → select `med_rxn` repo
   - Render reads `render.yaml`, deploys frontend

4. Test:
   - Open frontend URL, search medicines, add 2+, check warnings

---

## Cost Analysis

### One-Time Costs

| Task | Count | Cost/Unit | Total |
|------|-------|-----------|-------|
| Gap 3: 1,301 ingredients vs 54 drugs | 1 run | ₹52 | ₹52 |
| Gap 5: 224K pairs clinical effect | 1 run | ₹96 | ₹96 |
| **Total one-time** | | | **₹148** |

### Weekly Recurring Costs (Demo Tier)

| Task | Estimate | Cost/Unit | Cost/Week |
|------|----------|-----------|-----------|
| Gap 1: New unknown brands | 0–5 | ₹0.06 | ₹0–0.30 |
| Gap 3: New missing ingredients | 0–5 | ₹0.04 | ₹0–0.20 |
| Frontend/Backend hosting | — | Free (tier limits) | ₹0 |
| **Total/week** | | | **₹0–0.50** |

### Notes

- **HF Spaces free tier:** CPU Basic, 50GB disk, ephemeral (resets weekly). Cache files lost on restart; re-fetched from Dataset.
- **Render free tier:** 750 static site hours/month (~1 month uptime).
- **Gemini pricing:** $0.075 / 1M input tokens, $0.30 / 1M output tokens. Typical brand query: ~200 tokens, ~₹0.015–0.06.

### Production (Supabase + Render Pro)

For recordrx integration (not this demo):
- Postgres 10GB: ~₹3,000/month
- Render Pro: ~₹500/month
- Gemini: ~₹10–50/month (bulk enrichment + weekly updates)
- **Total: ~₹3,500–3,600/month**

---

## Resume-Safe Batch Processing

All enrichment scripts skip already-done work via cache CSVs.

### Gap 3 Update Script Example

```bash
# scripts/enrich-gap3.js
const fs = require('fs');
const { GeminiEnricher } = require('../backend/src/gemini');

const cacheFile = 'data/gap3_cache.csv';
const cache = new Map();

if (fs.existsSync(cacheFile)) {
  fs.readFileSync(cacheFile, 'utf8')
    .split('\n')
    .slice(1) // skip header
    .forEach(line => {
      const [ingredient] = line.split(',');
      cache.set(ingredient, true);
    });
}

// Process only new ingredients
const newIngredients = missingList.filter(ing => !cache.has(ing));

for (const ing of newIngredients) {
  const result = await gemini.enrichMissing(ing, commonDrugs);
  appendToCache(cacheFile, ing, result);
  console.log(`[gap3] enriched ${ing}`);
}
```

**Benefits:**
- Network failure → re-run script, skips done work
- Weekly updates: ~0–5 new ingredients → ~₹0.20/week
- No accumulation of duplicate Gemini calls

---

## File Structure

```
drug_reactions/
├── README.md                          # User-facing guide
├── Dockerfile                         # HF Spaces Docker config
├── render.yaml                        # Render deployment config
├── TECHNICAL_DOCUMENT.md              # This file
│
├── backend/
│   ├── package.json                   # Node.js deps
│   ├── server.js                      # Express app, startup, data download
│   └── src/
│       ├── engine.js                  # InteractionEngine, gap handling
│       ├── gemini.js                  # GeminiEnricher, prompt templates
│       ├── gap1Cache.js               # Gap 1 cache (in-memory)
│       └── gap3Cache.js               # Gap 3 cache (CSV-backed)
│
├── frontend/
│   ├── package.json
│   ├── vite.config.js
│   └── src/
│       ├── App.jsx                    # Prescription table
│       ├── components/
│       │   ├── MedicineModal.jsx      # Search + autocomplete
│       │   └── InteractionPanel.jsx   # Collapsible warnings
│       └── styles/
│           └── index.css
│
├── data/                              # Downloaded at HF Spaces startup
│   ├── interactions.csv               # 224K pairs
│   ├── 1mg_medicines_normalized.csv   # 252K SKUs
│   └── canonical_generics.csv         # 3.7K unique ingredients
│
├── scripts/                           # Batch enrichment (not runtime)
│   ├── gap3-enrich.js                 # Pre-fill missing ingredients
│   └── gap5-enrich.js                 # Add clinical effect text
│
└── node/                              # Production Postgres code (not in demo)
    ├── sql/
    │   ├── 01_schema.sql
    │   └── 02_load.sql
    └── src/
        ├── engine.js                  # Postgres version
        └── routes.js                  # API for recordrx
```

---

## Future Enhancements

1. **Postgres Integration** (recordrx)
   - Move in-memory engine to Postgres
   - Add patient history, dose tracking, notes
   - Scale to 100K+ concurrent users

2. **Richer Data** (DrugBank / Lexicomp)
   - Replace DDInter with DrugBank or Lexicomp API
   - More clinical detail, management guidelines

3. **Offline Mode**
   - Embed lightweight SQLite in React app
   - Sync with backend weekly

4. **CI/CD** (GitHub Actions)
   - Auto-run tests on PR
   - Auto-deploy on merge to main
   - Weekly data refresh via cron

5. **Monitoring** (Grafana / Sentry)
   - Track Gemini failures, token consumption
   - Alert on low cache hit rates
   - User feedback loop

---

## References

- **DDInter 2.0:** https://www.kaggle.com/datasets/sid321axn/drug-drug-interactions
- **Gemini API:** https://ai.google.dev/
- **HF Spaces:** https://huggingface.co/spaces
- **Render:** https://render.com/
- **recordrx:** [internal reference]

---

**Document Version:** 1.0  
**Last Updated:** 2026-05-14  
**Author:** Claude + Amulya K H
