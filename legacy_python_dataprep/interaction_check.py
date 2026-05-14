"""
Drug-drug interaction checker.

Pipeline:
  brand names (user input)
    -> BrandLookup.lookup() -> ingredients
    -> normalize_to_ddinter() -> DDInter drug names
    -> pairwise lookup against interactions.csv
    -> structured warnings

CLI:
  python3 scripts/interaction_check.py "Crocin 500" "Combiflam Tablet"
  python3 scripts/interaction_check.py "Warf 5" "Brufen 400" --json

Library:
  from interaction_check import InteractionEngine
  engine = InteractionEngine()
  result = engine.check(["Crocin 500", "Combiflam"])
"""

import argparse
import json
import sys
from dataclasses import dataclass, field, asdict
from itertools import combinations
from pathlib import Path

import pandas as pd

# Reuse the BrandLookup and the India->DDInter normalizer
sys.path.insert(0, str(Path(__file__).parent))
from brand_to_generic import BrandLookup
from build_interaction_db import normalize_to_ddinter


@dataclass
class Interaction:
    drug_a: str
    drug_b: str
    ingredient_a: str
    ingredient_b: str
    brand_a: str
    brand_b: str
    severity: str

    def as_dict(self):
        return asdict(self)


@dataclass
class CheckResult:
    inputs: list = field(default_factory=list)
    resolved_brands: list = field(default_factory=list)   # [{brand, ingredients}]
    unresolved_brands: list = field(default_factory=list)  # input strings we couldn't find
    no_data_ingredients: list = field(default_factory=list)  # ingredients not in DDInter
    interactions: list = field(default_factory=list)  # list[Interaction]

    def as_dict(self):
        d = asdict(self)
        d["interactions"] = [i for i in d["interactions"]]
        return d

    @property
    def severity_summary(self):
        c = {"Major": 0, "Moderate": 0, "Minor": 0, "Unknown": 0}
        for i in self.interactions:
            c[i.severity] = c.get(i.severity, 0) + 1
        return c


class InteractionEngine:
    def __init__(
        self,
        interactions_csv: str = "/Users/amulyakh/Desktop/drug_reactions/data/interactions.csv",
        ddinter_drugs_csv: str = "/Users/amulyakh/Desktop/drug_reactions/data/interaction_drugs.csv",
    ):
        self.brand_lookup = BrandLookup()
        ddi = pd.read_csv(interactions_csv)
        # Build a dict (drug_a, drug_b) -> severity. Pairs already alpha-sorted in build step.
        self._pair_index = {(a, b): s for a, b, s in zip(ddi["drug_a"], ddi["drug_b"], ddi["severity"])}
        self._known_drugs = set(pd.read_csv(ddinter_drugs_csv)["drug"])

    def check(self, brand_inputs: list[str]) -> CheckResult:
        result = CheckResult(inputs=list(brand_inputs))

        # 1) Resolve each brand input -> ingredients (per-brand)
        per_brand = []  # list of (input, brand_name_matched, [(ingredient, ddinter_name|None)])
        for q in brand_inputs:
            r = self.brand_lookup.lookup(q)
            if not r.matched:
                result.unresolved_brands.append(q)
                continue
            mapped_ings = []
            for ing in r.ingredients:
                ddi_name = normalize_to_ddinter(ing)
                if ddi_name in self._known_drugs:
                    mapped_ings.append((ing, ddi_name))
                else:
                    mapped_ings.append((ing, None))
                    if ing not in result.no_data_ingredients:
                        result.no_data_ingredients.append(ing)
            per_brand.append((q, r.brand_name, mapped_ings))
            result.resolved_brands.append({
                "input": q,
                "matched_brand": r.brand_name,
                "ingredients": [{"ingredient": i, "ddinter_name": d} for i, d in mapped_ings],
            })

        # 2) Pairwise check across DIFFERENT brands (don't compare a brand against itself)
        for (qa, brand_a, ings_a), (qb, brand_b, ings_b) in combinations(per_brand, 2):
            for ing_a, ddi_a in ings_a:
                if not ddi_a:
                    continue
                for ing_b, ddi_b in ings_b:
                    if not ddi_b:
                        continue
                    if ddi_a == ddi_b:
                        continue  # same drug from two brands -- not an interaction
                    key = tuple(sorted([ddi_a, ddi_b]))
                    sev = self._pair_index.get(key)
                    if sev:
                        result.interactions.append(Interaction(
                            drug_a=key[0], drug_b=key[1],
                            ingredient_a=ing_a, ingredient_b=ing_b,
                            brand_a=brand_a, brand_b=brand_b,
                            severity=sev,
                        ))
        # Sort: Major > Moderate > Minor > Unknown
        rank = {"Major": 0, "Moderate": 1, "Minor": 2, "Unknown": 3}
        result.interactions.sort(key=lambda x: rank.get(x.severity, 99))
        return result


def _print_result(r: CheckResult):
    print("=" * 74)
    print(f"INPUT BRANDS ({len(r.inputs)}):")
    for x in r.inputs:
        print(f"  - {x}")
    if r.unresolved_brands:
        print(f"\nUNRESOLVED BRANDS (not in our DB): {r.unresolved_brands}")
    print(f"\nRESOLVED:")
    for b in r.resolved_brands:
        ings_str = ", ".join(f"{i['ingredient']}" + ("" if i['ddinter_name'] else " [no_data]")
                             for i in b["ingredients"])
        print(f"  {b['input']:<25} -> {b['matched_brand']:<35} | {ings_str}")
    if r.no_data_ingredients:
        print(f"\nINGREDIENTS WITH NO INTERACTION DATA: {r.no_data_ingredients}")

    print(f"\nINTERACTIONS FOUND: {len(r.interactions)}    summary: {r.severity_summary}")
    if not r.interactions:
        print("  (none)")
    else:
        print("-" * 74)
        for i in r.interactions:
            print(f"  [{i.severity:<8}] {i.brand_a} + {i.brand_b}")
            print(f"               {i.ingredient_a} <> {i.ingredient_b}")
    print("=" * 74)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("brands", nargs="+", help="Two or more brand names to check")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if len(args.brands) < 2:
        print("Need at least 2 brand names to check for interactions.", file=sys.stderr)
        sys.exit(1)

    engine = InteractionEngine()
    result = engine.check(args.brands)

    if args.json:
        print(json.dumps(result.as_dict(), default=str, ensure_ascii=False, indent=2))
    else:
        _print_result(result)


if __name__ == "__main__":
    main()
