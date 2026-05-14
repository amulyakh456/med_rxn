"""
Search the 1mg medicines CSV.

Usage:
  python3 scripts/search.py crocin                       # brand contains "crocin"
  python3 scripts/search.py --generic paracetamol        # generic contains "paracetamol"
  python3 scripts/search.py --brand augmentin --dose 625 # brand AND dosage filters
  python3 scripts/search.py --manufacturer "Cipla Ltd"
  python3 scripts/search.py paracetamol --limit 5        # cap output
  python3 scripts/search.py --exact-brand "Dolo 650 Tablet"
"""

import argparse
import sys

import pandas as pd

CSV_PATH = "/Users/amulyakh/Desktop/drug_reactions/data/1mg_medicines_clean.csv"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="?", default=None,
                    help="search term (matched against brand_name + generic_name)")
    ap.add_argument("--brand")
    ap.add_argument("--generic")
    ap.add_argument("--dose")
    ap.add_argument("--form")
    ap.add_argument("--manufacturer")
    ap.add_argument("--exact-brand", help="exact case-insensitive brand match")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--csv", default=CSV_PATH)
    args = ap.parse_args()

    df = pd.read_csv(args.csv, low_memory=False)
    df = df.fillna("")

    mask = pd.Series(True, index=df.index)
    if args.query:
        q = args.query.lower()
        mask &= (df["brand_name"].str.lower().str.contains(q, regex=False)
                 | df["generic_name"].str.lower().str.contains(q, regex=False))
    if args.brand:
        mask &= df["brand_name"].str.lower().str.contains(args.brand.lower(), regex=False)
    if args.generic:
        mask &= df["generic_name"].str.lower().str.contains(args.generic.lower(), regex=False)
    if args.dose:
        mask &= df["dosage"].str.lower().str.contains(args.dose.lower(), regex=False)
    if args.form:
        mask &= df["dosage_form"].str.lower() == args.form.lower()
    if args.manufacturer:
        mask &= df["manufacturer"].str.lower().str.contains(args.manufacturer.lower(), regex=False)
    if args.exact_brand:
        mask &= df["brand_name"].str.lower() == args.exact_brand.lower()

    hits = df[mask]
    total = len(hits)

    if total == 0:
        print("No matches.", file=sys.stderr)
        return

    print(f"[{total:,} matches; showing first {min(total, args.limit)}]\n", file=sys.stderr)
    cols = ["brand_name", "generic_name", "dosage", "dosage_form", "manufacturer", "price"]
    out = hits[cols].head(args.limit)
    # Pretty print
    widths = [40, 35, 16, 14, 30, 8]
    print("  ".join(f"{c[:w]:<{w}}" for c, w in zip(cols, widths)))
    print("  ".join("-" * w for w in widths))
    for _, r in out.iterrows():
        print("  ".join(f"{str(r[c])[:w]:<{w}}" for c, w in zip(cols, widths)))


if __name__ == "__main__":
    main()
