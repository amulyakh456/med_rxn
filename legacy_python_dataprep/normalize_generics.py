"""
Normalize generic_name and emit:
  data/1mg_medicines_normalized.csv  -- same schema, cleaner generic_name
  data/brand_to_generics.csv         -- long format (1 row per active ingredient)
  data/canonical_generics.csv        -- master list of unique ingredients

Cleanup:
  - Strip leading manufacturer-suffix leakage: "LTD", "Ltd", "Pvt Ltd"
  - Drop short uppercase abbreviation tokens (ZDL, JPC, ATP, A, B, ...)
  - Standardize British -> US spellings (Amoxycillin -> Amoxicillin, etc.)
  - Title-case to merge case-only duplicates
  - Collapse whitespace
"""

import argparse
import re
from collections import Counter
from pathlib import Path

import pandas as pd

# Manual British->US (or India->international) standardization map.
# Only entries where one variant dominates and merging is unambiguous.
SPELLING_MAP = {
    "Amoxycillin": "Amoxicillin",
    "amoxycillin": "Amoxicillin",
    "Frusemide": "Furosemide",
    "Sulphamethoxazole": "Sulfamethoxazole",
    "Cefpodoxime Proxetil": "Cefpodoxime",
    "Cefuroxime Axetil": "Cefuroxime",
    # No Paracetamol -> Acetaminophen mapping: Paracetamol is the standard term
    # in India and most international interaction databases; converting would
    # break user expectation.
}

# Strip these leading manufacturer-suffix tokens from leaked ingredient strings.
LEADING_GARBAGE_RE = re.compile(
    r"^(?:LTD|Ltd|Pvt Ltd|pvt ltd|Pvt\.?\s*Ltd|Private Limited|MFG)\s*",
    re.IGNORECASE,
)


def title_case(name: str) -> str:
    """Title-case but preserve internal capitals like Acid, mg."""
    parts = []
    for w in name.split():
        if not w:
            continue
        # keep all-uppercase words like "DHA", "EPA" alone
        if w.isupper() and len(w) <= 4:
            parts.append(w)
        else:
            parts.append(w[:1].upper() + w[1:].lower())
    return " ".join(parts)


def normalize_ingredient(name: str) -> str:
    s = name.strip()
    if not s:
        return ""
    s = LEADING_GARBAGE_RE.sub("", s).strip()
    s = re.sub(r"\s+", " ", s)
    # Drop sub-4-character abbreviations (ZDL, JPC, ATP, A, B) — data noise
    if len(s) < 4:
        return ""
    s = title_case(s)
    s = SPELLING_MAP.get(s, s)
    return s


def normalize_generic(combo: str) -> str:
    """Apply normalize_ingredient to each + separated part, drop empties."""
    if not combo:
        return ""
    parts = [normalize_ingredient(p) for p in combo.split("+")]
    parts = [p for p in parts if p]
    return " + ".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="/Users/amulyakh/Desktop/drug_reactions/data/1mg_medicines_clean.csv")
    ap.add_argument("--out-medicines", default="/Users/amulyakh/Desktop/drug_reactions/data/1mg_medicines_normalized.csv")
    ap.add_argument("--out-long", default="/Users/amulyakh/Desktop/drug_reactions/data/brand_to_generics.csv")
    ap.add_argument("--out-canonical", default="/Users/amulyakh/Desktop/drug_reactions/data/canonical_generics.csv")
    args = ap.parse_args()

    df = pd.read_csv(args.input, low_memory=False)
    raw_n = len(df)
    df["generic_name"] = df["generic_name"].fillna("").astype(str)

    df["generic_name"] = df["generic_name"].map(normalize_generic)

    before_drop = len(df)
    df = df[df["generic_name"].str.strip() != ""].copy()
    print(f"[normalize] Dropped {before_drop - len(df):,} rows with empty generic after cleanup")

    df.to_csv(args.out_medicines, index=False)
    print(f"[normalize] Wrote {len(df):,} rows -> {args.out_medicines}")

    # Long format: one row per (brand_name, individual ingredient, position)
    long_rows = []
    for r in df.itertuples(index=False):
        ings = [p.strip() for p in str(r.generic_name).split("+")]
        for pos, ing in enumerate(ings):
            if ing:
                long_rows.append({
                    "brand_name": r.brand_name,
                    "ingredient": ing,
                    "ingredient_position": pos,
                    "ingredient_count": len(ings),
                    "dosage_form": r.dosage_form,
                    "manufacturer": r.manufacturer,
                })
    long_df = pd.DataFrame(long_rows)
    long_df.to_csv(args.out_long, index=False)
    print(f"[normalize] Wrote {len(long_df):,} long-format rows -> {args.out_long}")

    # Canonical generics list (master)
    counts = Counter(long_df["ingredient"])
    canonical = pd.DataFrame(
        sorted(counts.items(), key=lambda x: -x[1]),
        columns=["ingredient", "occurrence_count"],
    )
    canonical.to_csv(args.out_canonical, index=False)
    print(f"[normalize] Wrote {len(canonical):,} canonical ingredients -> {args.out_canonical}")

    # Quick audit
    print(f"\n[audit] Top 20 canonical ingredients:")
    print(canonical.head(20).to_string(index=False))

    print(f"\n[audit] Validation samples:")
    for q in ["Crocin Advance 500mg Tablet", "Augmentin 625 Duo Tablet", "Combiflam Tablet", "Dolo 650 Tablet"]:
        m = df[df["brand_name"] == q]
        if len(m):
            r = m.iloc[0]
            print(f"  {r['brand_name']:<35} -> {r['generic_name']}")


if __name__ == "__main__":
    main()
