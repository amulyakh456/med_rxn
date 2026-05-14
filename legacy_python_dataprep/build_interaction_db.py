"""
Combine + dedupe DDInter CSVs and emit:
  data/interactions.csv               -- canonical pair list
  data/interaction_drugs.csv          -- the 1,971 drugs DDInter knows
  data/india_to_ddinter_map.csv       -- our_ingredient -> ddinter_drug (after fixes)

Mapping pipeline:
  1. Lowercase + strip whitespace
  2. Apply hard-coded India -> DDInter name map (Paracetamol -> Acetaminophen, ...)
  3. Strip trailing salt suffixes (Maleate, Succinate, Sulphate, ...)
  4. Try direct match against DDInter drug set
"""

import glob
import re
from pathlib import Path

import pandas as pd

DDIR = Path("/Users/amulyakh/Desktop/drug_reactions/data/ddinter")
OUT = Path("/Users/amulyakh/Desktop/drug_reactions/data")

# Indian/British -> DDInter (US-style) name map
# Only entries where DDInter uses a different spelling than India does.
INDIA_TO_DDINTER = {
    "paracetamol": "acetaminophen",
    "lignocaine": "lidocaine",
    "lignocain": "lidocaine",
    "glibenclamide": "glyburide",
    "frusemide": "furosemide",
    "adrenaline": "epinephrine",
    "noradrenaline": "norepinephrine",
    "tazobactum": "tazobactam",          # source-data typo
    "amoxycillin": "amoxicillin",        # already mostly fixed in normalize step
    "amoxycillin trihydrate": "amoxicillin",
    "cyclosporin": "cyclosporine",
    "ciclosporin": "cyclosporine",
    "phenobarbitone": "phenobarbital",
    "thiopentone": "thiopental",
    "pethidine": "meperidine",
    "rifampicin": "rifampin",
    "trimethoprim sulphamethoxazole": "sulfamethoxazole",
    "sulphamethoxazole": "sulfamethoxazole",
    "aspirin": "acetylsalicylic acid",
    "asa": "acetylsalicylic acid",
    "atc": "acetylsalicylic acid",
    "salicylic acid": "salicylic acid",
}

# Salt suffixes to strip (e.g., "Metoprolol Succinate" -> "Metoprolol")
# Sorted longest-first so "Hydrochloride" wins over "Hydroch".
SALT_SUFFIXES = sorted([
    "Hydrochloride", "Dihydrochloride", "Trihydrate", "Monohydrate", "Dihydrate",
    "Hydrobromide", "Mesylate", "Maleate", "Tartrate", "Succinate", "Acetate",
    "Phosphate", "Citrate", "Sulphate", "Sulfate", "Bromide", "Chloride", "Iodide",
    "Fumarate", "Oxalate", "Furoate", "Aceponate", "Propionate", "Valerate",
    "Pivalate", "Pamoate", "Lactate", "Gluconate", "Sodium", "Potassium",
    "Calcium", "Magnesium", "Zinc", "HCl", "HBr", "Besylate", "Tosylate",
    "Nitrate", "Bicarbonate", "Carbonate", "Stearate", "Palmitate",
    "Hemifumarate", "Decanoate", "Enanthate", "Cypionate",
    "Disodium", "Dipotassium", "Camsylate",
], key=len, reverse=True)


def strip_salt(name: str) -> str:
    s = name.strip()
    # Multiple salts can chain (e.g., "Sodium Phosphate") — strip from end repeatedly
    changed = True
    while changed:
        changed = False
        for salt in SALT_SUFFIXES:
            if s.endswith(" " + salt) or s.endswith(" " + salt.lower()):
                s = s[: len(s) - len(salt) - 1].rstrip()
                changed = True
                break
    return s


def normalize_to_ddinter(india_name: str) -> str:
    """Return lowercase candidate name in DDInter style."""
    if not india_name:
        return ""
    s = india_name.strip()
    s = re.sub(r"\s+", " ", s)
    # Try salt-stripped version first (preserves base drug)
    base = strip_salt(s)
    candidates = [s.lower(), base.lower()]
    for c in candidates:
        if c in INDIA_TO_DDINTER:
            return INDIA_TO_DDINTER[c]
    # default: salt-stripped lowercase
    return base.lower()


def main():
    # --- combine + dedupe DDInter ---
    parts = [pd.read_csv(f) for f in sorted(glob.glob(str(DDIR / "ddinter_*.csv")))]
    ddi = pd.concat(parts, ignore_index=True)

    # Normalize drug name casing/whitespace
    ddi["Drug_A"] = ddi["Drug_A"].str.strip()
    ddi["Drug_B"] = ddi["Drug_B"].str.strip()
    ddi["_a_lc"] = ddi["Drug_A"].str.lower()
    ddi["_b_lc"] = ddi["Drug_B"].str.lower()

    # Drop topical/ophthalmic/parenthetical variants for our purposes
    # (e.g. "lidocaine (topical)" — keep one canonical form per base drug)
    def base(d):
        return re.sub(r"\s*\([^)]+\)\s*", "", d).strip().lower()
    ddi["_a_base"] = ddi["_a_lc"].map(base)
    ddi["_b_base"] = ddi["_b_lc"].map(base)

    # Canonical pair: sort alphabetically so (A,B) and (B,A) collapse
    pair_keys = ddi.apply(lambda r: tuple(sorted([r["_a_base"], r["_b_base"]])), axis=1)
    ddi["_key"] = pair_keys
    # Severity ordering for dedup-tie-break
    sev_rank = {"Major": 3, "Moderate": 2, "Minor": 1, "Unknown": 0}
    ddi["_sev"] = ddi["Level"].map(sev_rank).fillna(0)

    # Keep highest-severity row per pair
    ddi_sorted = ddi.sort_values("_sev", ascending=False)
    ddi_dedup = ddi_sorted.drop_duplicates(subset=["_key"], keep="first").copy()

    # Store pairs in alphabetical order so lookup with sorted keys is consistent
    ddi_dedup["drug_a"] = ddi_dedup["_key"].map(lambda k: k[0])
    ddi_dedup["drug_b"] = ddi_dedup["_key"].map(lambda k: k[1])
    out = ddi_dedup[["drug_a", "drug_b", "Level"]].rename(columns={"Level": "severity"})
    out_path = OUT / "interactions.csv"
    out.to_csv(out_path, index=False)
    print(f"[interactions] {len(out):,} unique pairs -> {out_path}")
    print(f"  severity dist: {out['severity'].value_counts().to_dict()}")

    # --- DDInter drug master list ---
    ddi_drugs = sorted(set(ddi["_a_base"]) | set(ddi["_b_base"]))
    pd.DataFrame({"drug": ddi_drugs}).to_csv(OUT / "interaction_drugs.csv", index=False)
    print(f"[drugs] {len(ddi_drugs):,} unique DDInter drugs -> {OUT / 'interaction_drugs.csv'}")

    # --- Build india -> DDInter mapping ---
    canon = pd.read_csv(OUT / "canonical_generics.csv")
    ddi_set = set(ddi_drugs)

    rows = []
    for _, r in canon.iterrows():
        ours = r["ingredient"]
        candidate = normalize_to_ddinter(ours)
        matched = candidate in ddi_set
        rows.append({
            "ingredient": ours,
            "ddinter_name": candidate if matched else "",
            "matched": matched,
            "occurrence_count": r["occurrence_count"],
        })
    map_df = pd.DataFrame(rows)
    map_df.to_csv(OUT / "india_to_ddinter_map.csv", index=False)

    matched_n = map_df["matched"].sum()
    matched_vol = map_df.loc[map_df["matched"], "occurrence_count"].sum()
    total_vol = map_df["occurrence_count"].sum()
    print(f"\n[mapping] {matched_n:,} / {len(map_df):,} ingredients matched ({100*matched_n/len(map_df):.1f}%)")
    print(f"[mapping] By SKU volume: {matched_vol:,} / {total_vol:,} ({100*matched_vol/total_vol:.1f}%)")

    print("\nTop 20 unmatched (still missing after normalization):")
    unm = map_df[~map_df["matched"]].sort_values("occurrence_count", ascending=False).head(20)
    for _, r in unm.iterrows():
        print(f"  {r['occurrence_count']:>5}  {r['ingredient']}")


if __name__ == "__main__":
    main()
