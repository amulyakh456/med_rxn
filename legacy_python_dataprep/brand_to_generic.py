"""
Brand -> Generic lookup module + CLI.

Lookup strategy (in order):
  1. Exact match on brand_name (case-insensitive)
  2. Brand-family match: ignore trailing dosage/form (e.g. "Crocin" matches "Crocin 500mg Tablet")
  3. Substring match: query is contained in brand_name (case-insensitive)
  4. Fuzzy match: difflib.get_close_matches (handles typos, casing oddities like CROcin)

Returns a structured result with:
  - the matched brand_name
  - list of active ingredients (split from generic_name)
  - dosage, dosage_form, manufacturer
  - confidence: "exact" | "family" | "substring" | "fuzzy:<ratio>"
  - all_candidates: list of close matches when not exact

CLI:
  python3 scripts/brand_to_generic.py "Crocin"
  python3 scripts/brand_to_generic.py "augmentin 625"
  python3 scripts/brand_to_generic.py "Cmbiflam"      # typo -> fuzzy
  python3 scripts/brand_to_generic.py "Kojiclar-H"    # not found

Library:
  from brand_to_generic import BrandLookup
  bl = BrandLookup()
  result = bl.lookup("Crocin")
"""

import argparse
import difflib
import re
import sys
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import pandas as pd

DEFAULT_CSV = "/Users/amulyakh/Desktop/drug_reactions/data/1mg_medicines_normalized.csv"

DOSAGE_FORM_TOKENS = {
    "tablet", "tablets", "capsule", "capsules", "syrup", "injection",
    "cream", "ointment", "gel", "lotion", "drops", "suspension", "spray",
    "powder", "sachet", "patch", "lozenge", "solution", "shampoo", "soap",
    "infusion", "elixir", "inhaler", "rotacaps", "respules", "granules",
    "er", "sr", "mr", "dt", "pr", "cr", "od", "xl", "duo",
}


@dataclass
class LookupResult:
    query: str
    matched: bool
    confidence: str = ""
    brand_name: str = ""
    generic_name: str = ""
    ingredients: list = field(default_factory=list)
    dosage: str = ""
    dosage_form: str = ""
    manufacturer: str = ""
    all_candidates: list = field(default_factory=list)

    def as_dict(self):
        return {
            "query": self.query,
            "matched": self.matched,
            "confidence": self.confidence,
            "brand_name": self.brand_name,
            "generic_name": self.generic_name,
            "ingredients": self.ingredients,
            "dosage": self.dosage,
            "dosage_form": self.dosage_form,
            "manufacturer": self.manufacturer,
            "all_candidates": self.all_candidates,
        }


def _strip_dosage_form_tokens(name: str) -> str:
    """Reduce 'Crocin 500mg Tablet' -> 'crocin' for family matching.
    Also strips standalone numbers ('Klacid 500' -> 'klacid')."""
    s = name.lower()
    s = re.sub(r"\d+(?:\.\d+)?\s*(mg|mcg|ml|g|gm|iu|%|w/w|w/v)\b", "", s)
    s = re.sub(r"[\(\)\|/]", " ", s)
    # Strip standalone numbers (purely numeric tokens after dosage cleanup)
    tokens = [t for t in re.split(r"\s+", s)
              if t and t not in DOSAGE_FORM_TOKENS and not re.fullmatch(r"\d+(?:\.\d+)?", t)]
    return " ".join(tokens).strip()


class BrandLookup:
    def __init__(self, csv_path: str = DEFAULT_CSV):
        self.df = pd.read_csv(csv_path, low_memory=False).fillna("")
        # Pre-build lookup indices
        self.df["_brand_lc"] = self.df["brand_name"].str.lower()
        self.df["_family"] = self.df["brand_name"].map(_strip_dosage_form_tokens)
        self._brand_lc_set = set(self.df["_brand_lc"].unique())
        self._family_set = sorted(set(self.df["_family"].unique()))

    @lru_cache(maxsize=1024)
    def lookup(self, query: str, max_candidates: int = 5) -> LookupResult:
        q = (query or "").strip()
        if not q:
            return LookupResult(query=query, matched=False)

        ql = q.lower()
        result = LookupResult(query=q, matched=False)

        # 1) Exact (case-insensitive) brand match
        hit = self.df[self.df["_brand_lc"] == ql]
        if len(hit):
            return self._fill(result, hit.iloc[0], "exact")

        # 2) Brand family (strip dosage/form)
        qf = _strip_dosage_form_tokens(q)
        if qf:
            hit = self.df[self.df["_family"] == qf]
            if len(hit):
                # If multiple SKUs share this family, return the first but expose all as candidates
                first = hit.iloc[0]
                cands = hit["brand_name"].head(max_candidates).tolist()
                r = self._fill(result, first, "family")
                r.all_candidates = cands
                return r

        # 3) Substring match against full brand
        hit = self.df[self.df["_brand_lc"].str.contains(re.escape(ql), regex=True, na=False)]
        if len(hit):
            first = hit.iloc[0]
            cands = hit["brand_name"].head(max_candidates).tolist()
            r = self._fill(result, first, "substring")
            r.all_candidates = cands
            return r

        # 3b) Substring match against family (handles "Klacid 500" -> "Klacid IV Injection")
        if qf:
            hit = self.df[self.df["_family"].str.contains(re.escape(qf), regex=True, na=False)]
            if len(hit):
                first = hit.iloc[0]
                cands = hit["brand_name"].head(max_candidates).tolist()
                r = self._fill(result, first, "family-substring")
                r.all_candidates = cands
                return r

        # 4) Fuzzy match against family set, then full brand if needed
        fuzzy_target = qf or ql
        close_families = difflib.get_close_matches(fuzzy_target, self._family_set, n=max_candidates, cutoff=0.7)
        if close_families:
            top = close_families[0]
            ratio = difflib.SequenceMatcher(None, fuzzy_target, top).ratio()
            hit = self.df[self.df["_family"] == top]
            if len(hit):
                first = hit.iloc[0]
                r = self._fill(result, first, f"fuzzy:{ratio:.2f}")
                # Surface a few close brand_names from the matched families
                r.all_candidates = (
                    self.df[self.df["_family"].isin(close_families)]["brand_name"].head(max_candidates).tolist()
                )
                return r

        return result  # not found

    def _fill(self, result: LookupResult, row, confidence: str) -> LookupResult:
        result.matched = True
        result.confidence = confidence
        result.brand_name = row["brand_name"]
        result.generic_name = row["generic_name"]
        result.ingredients = [p.strip() for p in str(row["generic_name"]).split("+") if p.strip()]
        result.dosage = str(row.get("dosage", ""))
        result.dosage_form = str(row.get("dosage_form", ""))
        result.manufacturer = str(row.get("manufacturer", ""))
        return result


def _print_result(r: LookupResult):
    if not r.matched:
        print(f"NOT FOUND: '{r.query}'")
        return
    print(f"Query:        {r.query}")
    print(f"Matched:      {r.brand_name}  [{r.confidence}]")
    print(f"Generic:      {r.generic_name}")
    print(f"Ingredients:  {r.ingredients}")
    print(f"Dosage:       {r.dosage}    Form: {r.dosage_form}")
    print(f"Manufacturer: {r.manufacturer}")
    if r.all_candidates and len(r.all_candidates) > 1:
        print(f"Other matches:")
        for c in r.all_candidates[:5]:
            print(f"   - {c}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="+", help="brand name(s) to look up")
    ap.add_argument("--csv", default=DEFAULT_CSV)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    bl = BrandLookup(args.csv)
    for q in args.query:
        r = bl.lookup(q)
        if args.json:
            import json
            print(json.dumps(r.as_dict(), ensure_ascii=False))
        else:
            _print_result(r)
            print()


if __name__ == "__main__":
    main()
