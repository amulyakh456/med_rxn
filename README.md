---
title: Drug Interactions API
emoji: 💊
colorFrom: red
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Drug Interaction POC — Node + React

End-to-end drug-interaction checker for Indian medicine prescriptions.
Aligned with recordrx's tech stack: **Node.js backend, React frontend,
Postgres/Supabase ready**.

## Project layout

```
drug_reactions/
├── backend/                    Node.js Express server (in-memory CSV engine)
│   ├── package.json
│   ├── server.js
│   └── src/engine.js
├── frontend/                   Vite + React app, recordrx-styled UI
│   ├── package.json
│   ├── vite.config.js
│   └── src/{App,components,styles}
├── data/                       Cleaned CSVs (input to backend at startup)
│   ├── 1mg_medicines_normalized.csv   252,997 SKUs
│   ├── canonical_generics.csv          3,780 unique active ingredients
│   ├── interactions.csv              224,449 unique drug-drug pairs
│   └── ddinter/                       raw 14 ATC files from DDInter 2.0
├── node/                       Postgres/Supabase production code (recordrx integration)
│   ├── sql/                            schema + load scripts + TSV data
│   ├── src/                            engine + Express/Next.js routes
│   ├── react/                          drop-in <InteractionPanel /> + CSS
│   └── README.md                       integration guide
└── legacy_python_dataprep/     One-time scripts that built the CSVs from Kaggle
                                (kept for reproducibility — not runtime)
```

## Run locally

Two terminals:

### Terminal 1 — backend
```bash
cd backend
npm install     # first time only
npm run dev     # http://localhost:3001
```

### Terminal 2 — frontend
```bash
cd frontend
npm install     # first time only
npm run dev     # http://localhost:5173
```

Open **http://localhost:5173** in a browser. Vite proxies `/api/*` to the
backend on :3001, so the React app uses relative URLs (matching how it'll
call recordrx endpoints in production).

## What you'll see

A recordrx-styled prescription page:
- **+ Add Medicine** opens a modal with autocomplete over 252,997 SKUs
- Pick a medicine, set frequency/duration/quantity, hit Add
- After 2+ medicines on the prescription, a yellow warning panel appears
  below the table — color-coded severity pills + per-pair detail rows
- Remove a medicine with the ✕ button — warnings recompute automatically

## API contract

```
GET  /api/health
GET  /api/search?q=cro
POST /api/check        body: { brands: ["Crocin 500", "Warf 5"] }
```

See `backend/src/engine.js` for the response shape.

## Going to production (recordrx integration)

The local backend uses the in-memory CSV engine for fast iteration.
For recordrx, swap to the Postgres/Supabase version in `/node/`:

1. Run `node/sql/01_schema.sql` then `02_load.sql` against the recordrx DB
2. Mount `node/src/routes.js` on the existing recordrx Express/Next.js server
3. Drop `node/react/InteractionPanel.jsx` into the recordrx prescription page

Full guide: [node/README.md](node/README.md)

## Coverage and limits

- Brand catalog: 252,997 1mg.com SKUs (snapshot 2025-10-22).
- Interaction coverage: 70% of SKUs by volume. Drugs not in DDInter
  (Domperidone, Aceclofenac, Nimesulide, Methylcobalamin, Serratiopeptidase,
  Pseudoephedrine, etc.) are reported in `no_data_ingredients` rather than
  silently dropped.
- DDInter provides severity labels only (Major / Moderate / Minor / Unknown);
  no clinical-management text. For richer data, swap to DrugBank / Lexicomp
  by editing only `engine.js`.
