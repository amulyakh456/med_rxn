"""
Extract clean list of unique ingredients from 1mg_medicines_normalized.csv that
are NOT in DDInter — these are the targets for Gap 3 enrichment.

Cleanup logic:
- The generic_name field is sometimes polluted with the manufacturer name prepended
  (e.g. "Aarcin Pharmaceutical Llpaceclofenac"). Strip everything up to and
  including the company suffix (Llp, Ltd, Limited, Pharmaceutical(s), Labs, etc).
- Strip standard salt suffixes (Hydrochloride, Sodium, etc).
- Apply India→DDInter normalization (Paracetamol→acetaminophen, etc).
"""
import csv
import re
import json
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / 'data'
OUT_FILE = DATA_DIR / 'gap3_missing_ingredients.json'

INDIA_TO_DDINTER = {
    'paracetamol': 'acetaminophen', 'lignocaine': 'lidocaine', 'lignocain': 'lidocaine',
    'glibenclamide': 'glyburide', 'frusemide': 'furosemide', 'adrenaline': 'epinephrine',
    'noradrenaline': 'norepinephrine', 'tazobactum': 'tazobactam',
    'amoxycillin': 'amoxicillin', 'amoxycillin trihydrate': 'amoxicillin',
    'cyclosporin': 'cyclosporine', 'ciclosporin': 'cyclosporine',
    'phenobarbitone': 'phenobarbital', 'thiopentone': 'thiopental',
    'pethidine': 'meperidine', 'rifampicin': 'rifampin',
    'sulphamethoxazole': 'sulfamethoxazole', 'aspirin': 'acetylsalicylic acid',
}

SALT_SUFFIXES = sorted([
    'hydrochloride','dihydrochloride','trihydrate','monohydrate','dihydrate',
    'hydrobromide','mesylate','maleate','tartrate','succinate','acetate',
    'phosphate','citrate','sulphate','sulfate','bromide','chloride','iodide',
    'fumarate','oxalate','furoate','aceponate','propionate','valerate',
    'pivalate','pamoate','lactate','gluconate','sodium','potassium',
    'calcium','magnesium','zinc','hcl','hbr','besylate','tosylate',
    'nitrate','bicarbonate','carbonate','stearate','palmitate',
    'hemifumarate','decanoate','enanthate','cypionate',
    'disodium','dipotassium','camsylate',
], key=len, reverse=True)

# Pattern: manufacturer name prepended to ingredient. Look for company-name terminators
# followed immediately by a lowercase letter (where the actual ingredient starts).
# Apply iteratively because some entries have multiple terminators stacked
# (e.g. "ai health care llpamoxycillin" needs both "health care" and "llp" stripped).
COMPANY_TERMINATORS = re.compile(
    r'.*?(llp|ltd|limited|pharmaceuticals?|health\s*care|healthcare|labs?(?:oratories)?'
    r'|industries|company|incorporated|inc|biotech|biosciences'
    r'|enterprises|sciences?|formulations|remedies|life\s*sciences?|lifesciences?'
    r'|life\s*care|lifecare|generics|mfg|manufactur(?:e|er|ing)?|medi[-\s]*healthcare)',
    re.IGNORECASE
)

# Standalone leading-noise prefixes seen in the data (not company-name terminators
# but prefixes that get prepended to ingredient names with no separator).
LEADING_NOISE = re.compile(r'^(overseas|bpl|svsd)(?=[a-z])', re.IGNORECASE)

# After cleanup, if the result still contains any of these tokens, the entry is
# corrupted beyond repair and should be discarded.
RESIDUAL_COMPANY_WORDS = {
    'llp','ltd','limited','pharmaceutical','pharmaceuticals','healthcare',
    'labs','laboratories','industries','biotech','biosciences','lifesciences',
    'lifecare','mfg','remedies','generics','enterprises','formulations',
}

def strip_manufacturer_pollution(text):
    """Remove leading manufacturer name from polluted generic_name. Iterative."""
    if not text:
        return text
    prev = None
    s = text
    while prev != s:
        prev = s
        # Strip leading noise prefixes (overseas, bpl, etc.)
        s = LEADING_NOISE.sub('', s)
        # Strip "<company name>(terminator)" prefix when an ingredient follows
        m = COMPANY_TERMINATORS.match(s)
        if m and m.end() < len(s):
            rest = s[m.end():]
            if rest and rest[0].isalpha() and rest[0].islower():
                s = rest
    return s

def looks_corrupted(s):
    """Reject entries that still contain company-related tokens after cleanup."""
    tokens = set(re.findall(r'[a-z]+', s.lower()))
    return bool(tokens & RESIDUAL_COMPANY_WORDS)

def strip_salt(s):
    s = s.strip().lower()
    changed = True
    while changed:
        changed = False
        for salt in SALT_SUFFIXES:
            if s.endswith(' ' + salt):
                s = s[:-len(salt) - 1].rstrip()
                changed = True
                break
    return s

def normalize_to_ddinter(s):
    s = s.strip().lower()
    s = re.sub(r'\s+', ' ', s)
    if s in INDIA_TO_DDINTER:
        return INDIA_TO_DDINTER[s]
    base = strip_salt(s)
    if base in INDIA_TO_DDINTER:
        return INDIA_TO_DDINTER[base]
    return base

def clean_ingredients(generic_name):
    """Split a generic_name on '+' and yield clean individual ingredients."""
    if not generic_name:
        return
    cleaned = strip_manufacturer_pollution(generic_name)
    for part in cleaned.split('+'):
        part = part.strip()
        if part:
            yield part

# ---- Load DDInter drugs ----
ddinter = set()
with open(DATA_DIR / 'interactions.csv') as f:
    for row in csv.DictReader(f):
        ddinter.add(row['drug_a'].strip().lower())
        ddinter.add(row['drug_b'].strip().lower())
print(f"DDInter drugs: {len(ddinter):,}")

# ---- Process 1mg medicines ----
ingredient_counts = {}    # cleaned ingredient (lowercase) -> count of medicines containing it
sample_brands = {}        # ingredient -> 1 sample brand for context

with open(DATA_DIR / '1mg_medicines_normalized.csv') as f:
    for row in csv.DictReader(f):
        for ing in clean_ingredients(row.get('generic_name', '')):
            key = ing.lower()
            ingredient_counts[key] = ingredient_counts.get(key, 0) + 1
            if key not in sample_brands:
                sample_brands[key] = row.get('brand_name', '')

print(f"Unique ingredients (after cleanup): {len(ingredient_counts):,}")

# ---- Filter to those missing from DDInter ----
missing = []
discarded_corrupted = 0
for ing, count in ingredient_counts.items():
    if looks_corrupted(ing):
        discarded_corrupted += 1
        continue
    if len(ing) < 3:
        discarded_corrupted += 1
        continue
    norm = normalize_to_ddinter(ing)
    if norm not in ddinter:
        missing.append({
            'ingredient': ing,
            'normalized': norm,
            'medicine_count': count,
            'sample_brand': sample_brands[ing],
        })

print(f"Discarded as corrupted/too-short: {discarded_corrupted:,}")

# Sort by medicine_count descending — most prescribed first
missing.sort(key=lambda x: -x['medicine_count'])

print(f"\nIngredients missing from DDInter: {len(missing):,}")
print(f"Top 20 by medicine count:")
for m in missing[:20]:
    print(f"  {m['medicine_count']:>6,}  {m['ingredient']:<40}  [{m['sample_brand']}]")

# Save full list for batch enrichment
OUT_FILE.write_text(json.dumps(missing, indent=2))
print(f"\nSaved {len(missing)} ingredients to {OUT_FILE}")
