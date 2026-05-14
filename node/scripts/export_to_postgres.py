"""
Export the cleaned CSVs into TSV files ready for Postgres COPY,
plus a SQL load script that uses \\copy.

Run:
    python3 node/scripts/export_to_postgres.py

Output:
    node/sql/data/medicines.tsv
    node/sql/data/medicine_ingredients.tsv
    node/sql/data/canonical_generics.tsv
    node/sql/data/india_to_ddinter_map.tsv
    node/sql/data/interactions.tsv
    node/sql/02_load.sql            -- runs the COPY commands
"""

import re
from pathlib import Path

import pandas as pd

DATA = Path("/Users/amulyakh/Desktop/drug_reactions/data")
OUT = Path("/Users/amulyakh/Desktop/drug_reactions/node/sql/data")
OUT.mkdir(parents=True, exist_ok=True)
SQL_DIR = Path("/Users/amulyakh/Desktop/drug_reactions/node/sql")


DOSAGE_FORM_TOKENS = {
    "tablet","tablets","capsule","capsules","syrup","injection","cream","ointment","gel",
    "lotion","drops","suspension","spray","powder","sachet","patch","lozenge","solution",
    "shampoo","soap","infusion","elixir","inhaler","rotacaps","respules","granules",
    "er","sr","mr","dt","pr","cr","od","xl","duo",
}


def family(name: str) -> str:
    s = name.lower()
    s = re.sub(r"\d+(?:\.\d+)?\s*(mg|mcg|ml|g|gm|iu|%|w/w|w/v)\b", "", s)
    s = re.sub(r"[\(\)\|/]", " ", s)
    tokens = [t for t in re.split(r"\s+", s)
              if t and t not in DOSAGE_FORM_TOKENS and not re.fullmatch(r"\d+(?:\.\d+)?", t)]
    return " ".join(tokens).strip()


def main():
    # ------------------------------ medicines ------------------------------
    meds = pd.read_csv(DATA / "1mg_medicines_normalized.csv", low_memory=False).fillna("")
    meds = meds.reset_index(drop=True)
    meds["id"] = meds.index + 1                     # explicit IDs so we can join the long-format file
    meds["brand_lc"] = meds["brand_name"].str.lower()
    meds["brand_family"] = meds["brand_name"].map(family)

    cols = ["id", "brand_name", "brand_lc", "brand_family", "generic_name",
            "dosage", "dosage_form", "manufacturer", "pack_size", "price",
            "prescription_required"]
    # Coerce price to numeric (strip ₹ etc)
    meds["price"] = pd.to_numeric(meds["price"].astype(str).str.replace(r"[^\d.]", "", regex=True),
                                  errors="coerce")
    meds[cols].to_csv(OUT / "medicines.tsv", sep="\t", index=False, header=False, na_rep="\\N")
    print(f"medicines.tsv: {len(meds):,} rows")

    # ------------------------------ medicine_ingredients ------------------------------
    long_rows = []
    for r in meds.itertuples(index=False):
        ings = [p.strip() for p in str(r.generic_name).split("+")]
        ings = [i for i in ings if i]
        for pos, ing in enumerate(ings):
            long_rows.append({
                "medicine_id": r.id,
                "ingredient": ing,
                "ingredient_position": pos,
                "ingredient_count": len(ings),
            })
    long_df = pd.DataFrame(long_rows)
    long_df.to_csv(OUT / "medicine_ingredients.tsv", sep="\t", index=False, header=False)
    print(f"medicine_ingredients.tsv: {len(long_df):,} rows")

    # ------------------------------ canonical_generics ------------------------------
    canon = pd.read_csv(DATA / "canonical_generics.csv")
    canon[["ingredient", "occurrence_count"]].to_csv(
        OUT / "canonical_generics.tsv", sep="\t", index=False, header=False)
    print(f"canonical_generics.tsv: {len(canon):,} rows")

    # ------------------------------ india_to_ddinter_map ------------------------------
    m = pd.read_csv(DATA / "india_to_ddinter_map.csv").fillna({"ddinter_name": ""})
    m[["ingredient", "ddinter_name", "matched", "occurrence_count"]].to_csv(
        OUT / "india_to_ddinter_map.tsv", sep="\t", index=False, header=False)
    print(f"india_to_ddinter_map.tsv: {len(m):,} rows")

    # ------------------------------ interactions ------------------------------
    inter = pd.read_csv(DATA / "interactions.csv")
    # Sort alphabetically (drug_a < drug_b) for the primary key
    swap = inter["drug_a"] > inter["drug_b"]
    a = inter["drug_a"].where(~swap, inter["drug_b"])
    b = inter["drug_b"].where(~swap, inter["drug_a"])
    inter = pd.DataFrame({"drug_a": a, "drug_b": b, "severity": inter["severity"]})
    inter = inter.drop_duplicates(subset=["drug_a", "drug_b"])
    inter.to_csv(OUT / "interactions.tsv", sep="\t", index=False, header=False)
    print(f"interactions.tsv: {len(inter):,} rows")

    # ------------------------------ 02_load.sql ------------------------------
    sql = """\
-- Run after 01_schema.sql. Uses \\copy so it works from psql with files
-- relative to this directory: node/sql/

\\copy rx.medicines (id, brand_name, brand_lc, brand_family, generic_name, dosage, dosage_form, manufacturer, pack_size, price, prescription_required) FROM 'data/medicines.tsv' WITH (FORMAT text, NULL '\\N');

SELECT setval(pg_get_serial_sequence('rx.medicines','id'), (SELECT max(id) FROM rx.medicines));

\\copy rx.medicine_ingredients (medicine_id, ingredient, ingredient_position, ingredient_count) FROM 'data/medicine_ingredients.tsv' WITH (FORMAT text);

\\copy rx.canonical_generics (ingredient, occurrence_count) FROM 'data/canonical_generics.tsv' WITH (FORMAT text);

\\copy rx.india_to_ddinter_map (ingredient, ddinter_name, matched, occurrence_count) FROM 'data/india_to_ddinter_map.tsv' WITH (FORMAT text);

\\copy rx.interactions (drug_a, drug_b, severity) FROM 'data/interactions.tsv' WITH (FORMAT text);

ANALYZE rx.medicines;
ANALYZE rx.medicine_ingredients;
ANALYZE rx.interactions;
"""
    (SQL_DIR / "02_load.sql").write_text(sql)
    print(f"\nWrote {SQL_DIR / '02_load.sql'}")


if __name__ == "__main__":
    main()
