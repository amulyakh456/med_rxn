# Weekly Scraping & Database Update Workflow

This folder contains scripts to keep the 1mg medicine catalog up-to-date and synchronized with the database.

## Overview

```
1. scrape_1mg_weekly.js   → Incremental scrape of new medicines + price updates
   ↓
2. diff_medicines.js      → Compare old vs new, generate report
   ↓
3. update_db_from_scrape.js → Load into database + enrich new medicines
```

## Scripts

### 1. `scrape_1mg_weekly.js`

**What it does:**
- Fetches sitemap.xml from 1mg.com
- Identifies NEW medicines (not in `.1mg_index.json`)
- Scrapes full details for new medicines (brand, generic, ingredients, dosage, price)
- Does lightweight price-only updates for existing medicines
- Maintains index of scraped URLs (incremental, not full re-scrape)

**Run:**
```bash
node scripts/scrape_1mg_weekly.js
```

**Output:**
- `data/1mg_medicines_weekly.csv` — All medicines (old + new, prices updated)
- `data/.1mg_index.json` — Internal index of scraped URLs

**Cron (Monday 2 AM):**
```bash
0 2 * * 1 cd /Users/amulyakh/Desktop/drug_reactions && node scripts/scrape_1mg_weekly.js >> logs/scrape_$(date +\%Y-\%m-\%d).log 2>&1
```

**Cost:**
- Week 1: ~252k requests (first full scrape)
- Week 2+: ~1-5k requests (only new medicines + prices)

---

### 2. `diff_medicines.js`

**What it does:**
- Compares `1mg_medicines_normalized.csv` (old) vs `1mg_medicines_weekly.csv` (new)
- Identifies:
  - **New medicines** (+1,500 SKUs)
  - **Removed medicines** (-200 SKUs)
  - **Price changes** (500+ price updates)
- Generates report for review

**Run:**
```bash
node scripts/diff_medicines.js
```

**Output:**
- `data/diff_report.json` — Detailed changes
- Console summary:
  ```
  📊 Diff Report
    Old medicines: 252,997
    New medicines: 254,297
    ➕ New SKUs: 1,500
    ➖ Removed SKUs: 200
    💰 Price changes: 523
    📈 Net change: +1,300
  ```

---

### 3. `update_db_from_scrape.js`

**What it does:**
- Reads diff report
- Plans (and optionally executes) database updates:
  - INSERT new medicines into `rx.medicines` + `rx.medicine_ingredients`
  - UPDATE prices for existing medicines
  - ARCHIVE removed medicines (mark `is_active = false`)
- Currently a dry-run (shows SQL; doesn't execute)

**Run:**
```bash
node scripts/update_db_from_scrape.js
```

**Output:**
- Console plan:
  ```
  📋 Database Update Plan
  1️⃣  INSERT 1,500 new medicines
  2️⃣  UPDATE 523 price changes
  3️⃣  ARCHIVE 200 removed medicines
  ```

**To execute (TODO):**
- Add Postgres connection
- Run INSERT/UPDATE statements
- Log audit trail

---

## Weekly Workflow

**Monday 2 AM (automated via cron):**
1. Scraper runs → `1mg_medicines_weekly.csv`
2. Send Slack notification with row count

**Tuesday morning (manual review):**
1. Run `diff_medicines.js` → review `diff_report.json`
2. Run `update_db_from_scrape.js` → see database update plan
3. If satisfied:
   - Execute database updates
   - Enrich new medicines (Gemini)
   - Commit to git

---

## Notes

### Respecting 1mg's robots.txt

✅ Allowed:
- Scraping individual medicine pages (e.g., `/medicines/aspirin-500`)
- Using sitemap.xml
- 2-5s delays between requests

❌ Not allowed:
- `/search` endpoint
- `/checkDrugInteraction` endpoint

### Incremental Updates

The scraper is **incremental** — it only re-scrapes NEW medicines, not all 252k.

**Week 1:** 252k requests (full scrape)
**Week 2:** ~5k requests (1-2% of catalog)
**Week 3+:** Similar to Week 2 (depends on market growth)

This keeps bandwidth and 1mg load minimal.

### Price Updates

Currently, prices are updated as a lightweight fetch (1 API call per existing medicine). This can be optimized further if needed.

---

## TODO

1. **Connect to Postgres** in `update_db_from_scrape.js`
2. **Enrich new medicines** — Integrate with `enrich_ddinter.js`
3. **Error handling** — Graceful failures, retries
4. **Monitoring** — Slack alerts for scrape failures
5. **Logging** — Audit trail of what changed

---

## Example Run

```bash
# First time setup (full scrape)
$ node scripts/scrape_1mg_weekly.js
Fetching sitemap.xml...
Found 252997 medicine URLs in sitemap

Summary:
  Total URLs in sitemap: 252,997
  Already scraped: 0
  New to scrape: 252,997

Phase 1: Scraping 252,997 new medicines...
[1/252997] aspirin-500 ✓
[2/252997] ibuprofen-200 ✓
...
✅ Done in 3600.5s
   New: 252997/252997 success
   Index entries: 252,997
   Output: data/1mg_medicines_weekly.csv

# Next week (incremental)
$ node scripts/scrape_1mg_weekly.js
Found 254297 medicine URLs in sitemap

Summary:
  Total URLs in sitemap: 254,297
  Already scraped: 252,997
  New to scrape: 1,300

Phase 1: Scraping 1,300 new medicines...
[1/1300] crocin-650 ✓
...
Phase 2: Updating prices for 252,997 existing medicines...
[1/252997] aspirin-500 ✓ (₹25)
...
✅ Done in 850.2s
   New: 1300/1300 success
   Updated: 252997/252997 success

# Review changes
$ node scripts/diff_medicines.js
📊 Diff Report
  Old medicines: 252,997
  New medicines: 254,297
  ➕ New SKUs: 1,300
  ➖ Removed SKUs: 0
  💰 Price changes: 523
  📈 Net change: +1,300

# Plan database update
$ node scripts/update_db_from_scrape.js
📋 Database Update Plan
1️⃣  INSERT 1,300 new medicines
2️⃣  UPDATE 523 price changes
```

---

## References

- 1mg robots.txt: https://www.1mg.com/robots.txt
- 1mg sitemap: https://www.1mg.com/sitemap.xml
- Enrichment: See `enrich_ddinter.js` for Gemini integration
