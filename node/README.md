# Drug Interaction Module — recordrx integration

A drop-in module that adds drug-drug interaction checking to the existing
recordrx prescription flow. Aligned with the project's tech-stack constraint:

- **Backend:** Node.js (uses the existing recordrx Express / Next.js server)
- **Database:** Postgres / Supabase (5 new tables in the `rx` schema)
- **Frontend:** React component dropped into the existing prescription page
- **Auth:** uses recordrx's existing auth middleware

No new service to deploy. No new auth. No standalone prototype.

---

## What's in here

```
node/
├── sql/
│   ├── 01_schema.sql          ← creates 5 tables in `rx` schema + indexes
│   ├── 02_load.sql            ← loads data via \copy (run after 01)
│   └── data/                  ← TSV files (~250K rows) ready for COPY
├── src/
│   ├── interactionEngine.js   ← the engine class (Postgres-backed)
│   └── routes.js              ← Express + Next.js route handlers
├── react/
│   ├── InteractionPanel.jsx   ← <InteractionPanel /> drop-in component
│   └── interactionPanel.css   ← matching styles
├── scripts/
│   └── export_to_postgres.py  ← regenerates the TSV files (already run)
└── README.md
```

---

## Setup — three steps

### 1. Load data into Postgres / Supabase

```bash
cd node/sql
psql "$DATABASE_URL" -f 01_schema.sql
psql "$DATABASE_URL" -f 02_load.sql      # ~30 sec on a small DB
```

Loads:
- `rx.medicines` — 252,997 SKU rows
- `rx.medicine_ingredients` — 415,096 long-format rows (1 per active ingredient)
- `rx.canonical_generics` — 3,780 distinct ingredients
- `rx.india_to_ddinter_map` — Indian-name → DDInter-name mapping
- `rx.interactions` — 224,449 unique drug-drug interaction pairs

If you're using Supabase: open the SQL editor and paste each file in turn.
For the `\copy` commands you'll need psql CLI access; alternatively use
Supabase's CSV import UI on the TSV files.

### 2. Wire the engine into the existing recordrx server

**If recordrx uses Express:**

```js
// in your existing server.js / app.js
const { Pool } = require('pg');
const { mountInteractionRoutes } = require('./interactions/routes');
const requireAuth = require('./middleware/auth');   // existing recordrx auth

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
mountInteractionRoutes(app, pool, { authMiddleware: requireAuth });
```

That's it. Three new endpoints are now mounted:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/interactions/health` | readiness probe |
| GET | `/api/interactions/search?q=cro` | autocomplete (top 10) |
| POST | `/api/interactions/check` | `{brands: [...]}` → severity-ranked warnings |

**If recordrx uses Next.js App Router:** see the example block at the bottom
of `src/routes.js`. Copy `interactionEngine.js` into `lib/interactions/` and
create thin route handlers under `app/api/interactions/{check,search}/route.js`.

### 3. Add the React component to the prescription page

```jsx
import InteractionPanel from '@/components/interactions/InteractionPanel';
import '@/components/interactions/interactionPanel.css';

// inside your prescription component:
<>
  <PrescriptionTable medicines={prescription} />
  <AddMedicineButton onAdd={addMedicineHandler} />

  <InteractionPanel medicines={prescription} />
</>
```

The component:
- watches `medicines` prop, debounces 250 ms, then calls `/api/interactions/check`
- renders nothing if fewer than 2 medicines are on the prescription
- shows a green "no interactions" banner OR a yellow warning panel with
  severity pills + per-pair detail rows
- needs no other configuration

For per-row indicators (yellow triangle next to one medicine), use the smaller
`<InteractionTriangle severity="Major" />` exported from the same file.

---

## API contract

```http
POST /api/interactions/check
content-type: application/json
authorization: Bearer <existing recordrx token>

{ "brands": ["Crocin 500", "Warf 5", "Brufen 400"] }
```

Response:

```jsonc
{
  "resolved_brands": [
    { "input": "Crocin 500",
      "matched_brand": "CROcin 1000mg Tablet",
      "ingredients": [{ "ingredient": "Paracetamol",
                        "ddinter_name": "acetaminophen" }] },
    ...
  ],
  "unresolved_brands": [],
  "no_data_ingredients": ["Domperidone"],     // present in our DB, not in DDInter
  "interactions": [
    { "severity": "Major",
      "brand_a": "Warf 4mg Tablet", "brand_b": "Brufen 400 Tablet",
      "ingredient_a": "Warfarin",   "ingredient_b": "Ibuprofen",
      "drug_a": "ibuprofen",        "drug_b": "warfarin" }
  ],
  "severity_summary": { "Major": 1, "Moderate": 0, "Minor": 0, "Unknown": 0 }
}
```

---

## Coverage and limits

- **Brand coverage:** 252,997 SKUs from a 1mg.com snapshot (Oct 2025).
  Brands not on 1mg (e.g. Apollo-only products) won't be found.
- **Interaction coverage:** ~70% of SKUs by volume. The other 30% contain at
  least one ingredient (Domperidone, Aceclofenac, Nimesulide, Methylcobalamin,
  Serratiopeptidase, etc.) that DDInter doesn't track. These are reported in
  `no_data_ingredients` rather than silently dropped.
- **Severity labels only.** DDInter has no clinical mechanism text. If a richer
  source is needed later (DrugBank, Lexicomp), only `interactionEngine.js`
  needs to change — the route + React component stay the same.

## Updating the catalog

The TSV files are a snapshot. To refresh:

```bash
python3 scripts/export_to_postgres.py     # regenerates TSVs from data/*.csv
psql "$DATABASE_URL" < node/sql/01_schema.sql
psql "$DATABASE_URL" < node/sql/02_load.sql
```

For a more sophisticated refresh strategy (incremental update, live fallback
on cache miss), see the project README's "Updating" section.
