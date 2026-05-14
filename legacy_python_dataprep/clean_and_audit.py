"""
Clean, dedupe and audit the parsed 1mg medicine CSV.

Rules:
- Drop rows with empty brand_name OR empty generic_name (essential for validation use)
- Dedupe on (brand_name, dosage, manufacturer) — keep first occurrence
- Standardize: trim whitespace, lowercase generic-name comparisons for dedup keys
- Print audit report: row counts, brand coverage, null rates, sample inspection
"""

import argparse
import sys
from pathlib import Path

import pandas as pd

POPULAR_BRANDS = [
    "Crocin", "Augmentin", "Combiflam", "Dolo", "Calpol", "Azithral",
    "Telma", "Ecosprin", "Glycomet", "Volini", "Saridon", "Norflox",
    "Allegra", "Levipil", "Clavam", "Moxikind", "Zerodol", "Pan 40",
    "Pantop", "Cipro", "Aciloc", "Rantac", "Brufen", "Voveran", "Zifi",
    "Mox", "Taxim", "Cetzine", "Avil", "Sumo", "Meftal", "Spasmonil",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="/Users/amulyakh/Desktop/drug_reactions/data/1mg_medicines_database.csv")
    ap.add_argument("--output", default="/Users/amulyakh/Desktop/drug_reactions/data/1mg_medicines_clean.csv")
    args = ap.parse_args()

    df = pd.read_csv(args.input, low_memory=False)
    raw_n = len(df)
    print(f"[audit] Raw rows: {raw_n:,}")

    # 1) Drop rows with missing brand or generic
    valid = df[df["brand_name"].notna() & (df["brand_name"].str.strip() != "")
               & df["generic_name"].notna() & (df["generic_name"].str.strip() != "")].copy()
    dropped = raw_n - len(valid)
    print(f"[audit] Dropped (no brand or generic): {dropped:,} ({100*dropped/raw_n:.2f}%)")

    # 2) Standardize whitespace
    for col in ["brand_name", "generic_name", "dosage", "dosage_form", "manufacturer", "pack_size"]:
        valid[col] = valid[col].fillna("").astype(str).str.strip()

    # 3) Build dedup key: (brand_name lower, dosage, manufacturer lower)
    valid["_dk"] = (valid["brand_name"].str.lower()
                    + "|" + valid["dosage"].str.lower()
                    + "|" + valid["manufacturer"].str.lower())
    before = len(valid)
    valid = valid.drop_duplicates(subset=["_dk"], keep="first").drop(columns=["_dk"])
    dup_removed = before - len(valid)
    print(f"[audit] Dropped (duplicates by brand+dosage+manufacturer): {dup_removed:,}")

    # 4) Save
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    valid.to_csv(out_path, index=False)
    print(f"[audit] Final clean rows: {len(valid):,} -> {out_path}\n")

    # 5) Audit
    print("=" * 70)
    print("AUDIT REPORT")
    print("=" * 70)

    print("\nDOSAGE FORM DISTRIBUTION (top 15):")
    print(valid["dosage_form"].replace("", "<unknown>").value_counts().head(15).to_string())

    print("\nBRAND-NAME FIRST-LETTER COVERAGE:")
    fl = valid["brand_name"].str[0].str.upper().value_counts().sort_index()
    print(fl.to_string())

    print("\nNULL/EMPTY RATES:")
    for col in valid.columns:
        empty = (valid[col].astype(str).str.strip() == "").sum()
        print(f"  {col:<25} empty: {empty:>7,} ({100*empty/len(valid):.2f}%)")

    print("\nPOPULAR BRAND COVERAGE:")
    for brand in POPULAR_BRANDS:
        m = valid[valid["brand_name"].str.contains(brand, case=False, na=False, regex=False)]
        if len(m) == 0:
            print(f"  {brand:<12} 0  *MISSING*")
        else:
            ex = m.iloc[0]
            print(f"  {brand:<12} {len(m):>4}  e.g. {ex['brand_name'][:40]:<40} -> {ex['generic_name'][:40]}")

    print("\nUNIQUE GENERICS (top 20 most common):")
    print(valid["generic_name"].value_counts().head(20).to_string())

    print(f"\nUNIQUE BRANDS:    {valid['brand_name'].nunique():,}")
    print(f"UNIQUE GENERICS:  {valid['generic_name'].nunique():,}")
    print(f"UNIQUE MANUFACTURERS: {valid['manufacturer'].nunique():,}")


if __name__ == "__main__":
    main()
