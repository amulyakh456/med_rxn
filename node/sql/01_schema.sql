-- Drug interaction schema for recordrx (Postgres / Supabase)
--
-- Idempotent: drops and recreates. Run from psql or Supabase SQL editor:
--   psql "$DATABASE_URL" < 01_schema.sql

-- pg_trgm enables fuzzy matching via similarity() / trigram indexes
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Optional namespace so this isolated from the rest of recordrx tables
CREATE SCHEMA IF NOT EXISTS rx;

DROP TABLE IF EXISTS rx.medicine_ingredients CASCADE;
DROP TABLE IF EXISTS rx.medicines CASCADE;
DROP TABLE IF EXISTS rx.canonical_generics CASCADE;
DROP TABLE IF EXISTS rx.india_to_ddinter_map CASCADE;
DROP TABLE IF EXISTS rx.interactions CASCADE;

-- 1) medicines: 252,997 SKUs from 1mg
CREATE TABLE rx.medicines (
  id BIGSERIAL PRIMARY KEY,
  brand_name      TEXT NOT NULL,
  brand_lc        TEXT NOT NULL,            -- lowercase for case-insensitive lookup
  brand_family    TEXT NOT NULL,            -- 'crocin' from 'CROcin 500mg Tablet' (no dosage/form/numbers)
  generic_name    TEXT NOT NULL,
  dosage          TEXT,
  dosage_form     TEXT,
  manufacturer    TEXT,
  pack_size       TEXT,
  price           NUMERIC,
  prescription_required TEXT
);

CREATE INDEX medicines_brand_lc_idx       ON rx.medicines (brand_lc);
CREATE INDEX medicines_brand_family_idx   ON rx.medicines (brand_family);
CREATE INDEX medicines_brand_lc_trgm_idx  ON rx.medicines USING gin (brand_lc gin_trgm_ops);
CREATE INDEX medicines_brand_family_trgm  ON rx.medicines USING gin (brand_family gin_trgm_ops);

-- 2) medicine_ingredients: 1 row per (medicine, ingredient) — long format
CREATE TABLE rx.medicine_ingredients (
  medicine_id BIGINT NOT NULL REFERENCES rx.medicines(id) ON DELETE CASCADE,
  ingredient TEXT NOT NULL,
  ingredient_position INT NOT NULL,
  ingredient_count INT NOT NULL,
  PRIMARY KEY (medicine_id, ingredient_position)
);
CREATE INDEX medicine_ingredients_ing_idx ON rx.medicine_ingredients (lower(ingredient));

-- 3) canonical_generics: master list of 3,780 unique active ingredients
CREATE TABLE rx.canonical_generics (
  ingredient TEXT PRIMARY KEY,
  occurrence_count INT NOT NULL
);

-- 4) india_to_ddinter_map: how each Indian-name ingredient maps to DDInter
CREATE TABLE rx.india_to_ddinter_map (
  ingredient TEXT PRIMARY KEY,
  ddinter_name TEXT,                        -- empty string when not mapped
  matched BOOLEAN NOT NULL,
  occurrence_count INT NOT NULL
);
CREATE INDEX india_map_ddinter_idx ON rx.india_to_ddinter_map (ddinter_name) WHERE matched;

-- 5) interactions: 224,449 unique pairs from DDInter (alphabetically sorted drug_a < drug_b)
CREATE TABLE rx.interactions (
  drug_a TEXT NOT NULL,
  drug_b TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('Major','Moderate','Minor','Unknown')),
  PRIMARY KEY (drug_a, drug_b)
);
-- Reverse-direction lookups too (so we don't have to alpha-sort at query time)
CREATE INDEX interactions_drug_b_idx ON rx.interactions (drug_b, drug_a);
