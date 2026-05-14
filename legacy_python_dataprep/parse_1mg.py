"""
Parse apkaayush/india-medicines-and-drug-info-dataset into a clean
brand -> generic mapping CSV.

Source `Product Name` field is a concatenation of:
  {brand}MRP[₹|?]{price}[Prescription Required]{pack_size}{manufacturer}{composition}(ADD|not available)

Output columns:
  brand_name | generic_name | dosage | dosage_form | manufacturer | pack_size | price | prescription_required
"""

import argparse
import csv
import re
import sys
from pathlib import Path

import pandas as pd

DOSAGE_FORMS = sorted([
    "Tablet ER", "Tablet SR", "Tablet MR", "Tablet DT", "Tablet PR", "Tablet CR",
    "Capsule SR", "Capsule ER", "Capsule MR",
    "Tablet", "Capsule",
    "Oral Suspension", "Suspension",
    "Eye/Ear Drops", "Eye Drops", "Ear Drops", "Nasal Drops",
    "Drops",
    "Syrup", "Elixir", "Linctus", "Tonic",
    "Injection", "Infusion",
    "Cream", "Ointment", "Gel", "Lotion", "Soap", "Shampoo",
    "Powder", "Granules", "Sachet",
    "Spray", "Inhaler", "Rotacaps", "Respules", "Nebuliser Solution",
    "Solution", "Mouthwash",
    "Suppository", "Pessary",
    "Patch", "Lozenge",
    "Liquid",
    "Bar",
    "Mouth Paint", "Foam",
], key=len, reverse=True)

PACK_PREFIXES = sorted([
    "strip of", "bottle of", "vial of", "tube of", "jar of", "box of",
    "packet of", "sachet of", "pack of", "tin of", "carton of",
    "ampoule of", "ampoules of", "pouch of", "tray of", "blister of",
    "prefilled syringe of", "pre filled syringe of", "pre-filled syringe of",
    "cartridge of", "pen of", "device of", "kit of", "tetrapack of",
    "pump bottle of", "spray bottle of", "rollon bottle of",
    "drops of", "bag of",
], key=len, reverse=True)

PREFIX_ALT = "(?:" + "|".join(re.escape(p) for p in PACK_PREFIXES) + ")"

# Build form list including all four casings of plural so we don't have to
# rely on IGNORECASE — the lookahead must remain case-sensitive to detect the
# manufacturer boundary (uppercase letter following pack).
_FORMS_WITH_PLURALS = set()
for _f in DOSAGE_FORMS:
    _FORMS_WITH_PLURALS.add(_f)
    _FORMS_WITH_PLURALS.add(_f.lower())
    if not _f.endswith("s"):
        _FORMS_WITH_PLURALS.add(_f + "s")
        _FORMS_WITH_PLURALS.add(_f.lower() + "s")
_FORMS_WITH_PLURALS = sorted(_FORMS_WITH_PLURALS, key=len, reverse=True)
FORM_ALT = "(?:" + "|".join(re.escape(f) for f in _FORMS_WITH_PLURALS) + ")"

# No IGNORECASE — the lookahead `[A-Z\s]|$` must be strict (uppercase, whitespace,
# or EOS) to distinguish "Oral Suspension" + manufacturer "Sanofi" from the
# false-greedy "Oral SuspensionS" + "anofi". Prefixes are always lowercase in
# the source data; forms are explicitly listed in all expected casings above.
PACK_RE = re.compile(rf"(?P<pack>{PREFIX_ALT}\s+.+?{FORM_ALT})(?=[A-Z\s]|$)")
TRAILER_RE = re.compile(r"(ADD|not available)\s*$", re.IGNORECASE)
PRICE_RE = re.compile(r"MRP[₹?]([\d,]+(?:\.\d+)?)")
PRESCRIPTION_RE = re.compile(r"Prescription Required", re.IGNORECASE)

# composition tokens like "Paracetamol (500mg)" or "Liquid Paraffin (10.1% w/w)"
COMP_TOKEN = re.compile(r"([A-Za-z][A-Za-z\-/'\s]*?)\s*\(([^)]+)\)")


def extract_dosage_form(name: str) -> str:
    """Pick the dosage form from the brand name (longest match wins)."""
    for form in DOSAGE_FORMS:  # already longest-first
        if re.search(r"\b" + re.escape(form) + r"\b", name, re.IGNORECASE):
            return form
    return ""


def extract_dosage_from_composition(comp: str) -> str:
    """Aggregate dose strings: 'Ibuprofen (400mg) + Paracetamol (325mg)' -> '400mg+325mg'."""
    doses = re.findall(r"\(([^)]+)\)", comp)
    doses = [d.strip().replace(" ", "") for d in doses if d.strip()]
    return "+".join(doses)


def extract_generic(comp: str) -> str:
    """Extract drug names joined by ' + '."""
    tokens = COMP_TOKEN.findall(comp)
    if not tokens:
        return ""
    names = []
    for name, _dose in tokens:
        n = re.sub(r"\s+", " ", name).strip(" -/'")
        if n:
            names.append(n)
    return " + ".join(names)


def split_manufacturer_composition(after_pack: str) -> tuple[str, str]:
    """
    after_pack = "{manufacturer}{composition}". The boundary is the LAST
    lowercase->uppercase transition before the first '(' in composition.
    """
    first_paren = after_pack.find("(")
    if first_paren < 0:
        return after_pack.strip(), ""
    region = after_pack[:first_paren]
    boundary = -1
    for m in re.finditer(r"(?<=[a-z])(?=[A-Z])", region):
        boundary = m.start()
    if boundary < 0:
        # Fallback: if region ends with a capitalized word, treat that as composition start.
        m2 = re.search(r"[A-Z][A-Za-z\-/'\s]*$", region)
        boundary = m2.start() if m2 else first_paren
    return after_pack[:boundary].strip(), after_pack[boundary:].strip()


def parse_product_name(product_name: str) -> dict:
    out = {
        "brand_name": "",
        "price": "",
        "prescription_required": "",
        "pack_size": "",
        "manufacturer": "",
        "composition_raw": "",
        "generic_name": "",
        "dosage": "",
        "dosage_form": "",
    }

    s = product_name or ""
    if not s:
        return out

    # 1) Split on MRP marker (anchors the brand on the left)
    m = PRICE_RE.search(s)
    if not m:
        return out

    brand = s[: m.start()].strip()
    price = m.group(1).replace(",", "")
    rest = s[m.end():]

    # 2) Strip prescription marker
    pres = bool(PRESCRIPTION_RE.search(rest))
    rest = PRESCRIPTION_RE.sub("", rest).strip()

    # 3) Extract pack size (first match)
    pack_m = PACK_RE.search(rest)
    if pack_m:
        pack = pack_m.group("pack").strip()
        after_pack = rest[pack_m.end():]
    else:
        pack = ""
        after_pack = rest

    # 4) Strip trailer (ADD | not available)
    trailer_m = TRAILER_RE.search(after_pack)
    if trailer_m:
        after_pack = after_pack[: trailer_m.start()].rstrip()

    # 5) Split manufacturer / composition on lowercase->uppercase transition
    manufacturer, composition = split_manufacturer_composition(after_pack)

    out["brand_name"] = re.sub(r"\s+", " ", brand).strip()
    out["price"] = price
    out["prescription_required"] = "Yes" if pres else "No"
    out["pack_size"] = pack
    out["manufacturer"] = manufacturer
    out["composition_raw"] = composition
    out["generic_name"] = extract_generic(composition) if composition else ""
    out["dosage"] = extract_dosage_from_composition(composition) if composition else ""
    out["dosage_form"] = extract_dosage_form(brand)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="/Users/amulyakh/.cache/kagglehub/datasets/apkaayush/india-medicines-and-drug-info-dataset/versions/1/India Medicines and Drug Info Dataset.csv")
    ap.add_argument("--output", default="/Users/amulyakh/Desktop/drug_reactions/data/1mg_medicines_database.csv")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--sample", action="store_true")
    args = ap.parse_args()

    df = pd.read_csv(args.input, low_memory=False)
    if args.limit:
        df = df.head(args.limit)

    print(f"[info] Input rows: {len(df):,}", file=sys.stderr)

    parsed = []
    miss_brand = miss_generic = no_price = 0
    for row in df.itertuples(index=False):
        product_name = str(row[2])  # 'Product Name' column
        rec = parse_product_name(product_name)
        if not rec["brand_name"]:
            miss_brand += 1
            if not rec["price"]:
                no_price += 1
        if not rec["generic_name"]:
            miss_generic += 1
        parsed.append(rec)

    if args.sample:
        for r in parsed[:25]:
            print(r)
        return

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    cols = ["brand_name", "generic_name", "dosage", "dosage_form", "manufacturer", "pack_size", "price", "prescription_required"]
    with out_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in parsed:
            w.writerow({k: r.get(k, "") for k in cols})

    n = len(parsed)
    print(f"[info] Wrote {n:,} rows -> {out_path}", file=sys.stderr)
    print(f"[info] Missing brand:   {miss_brand:,} ({100*miss_brand/n:.1f}%)  [no MRP marker: {no_price:,}]", file=sys.stderr)
    print(f"[info] Missing generic: {miss_generic:,} ({100*miss_generic/n:.1f}%)", file=sys.stderr)


if __name__ == "__main__":
    main()
