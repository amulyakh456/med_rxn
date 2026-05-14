-- Migration: Add clinical_effect to interactions table
-- Run AFTER 01_schema.sql and 02_load.sql have been applied.
--
-- Usage:
--   psql "$DATABASE_URL" < 03_migration_add_clinical_effect.sql

-- 1) Add clinical_effect column (nullable for backwards compatibility)
ALTER TABLE rx.interactions
  ADD COLUMN IF NOT EXISTS clinical_effect TEXT;

-- 2) Index for full-text search on clinical effects (optional)
CREATE INDEX IF NOT EXISTS interactions_clinical_effect_trgm
  ON rx.interactions USING gin (clinical_effect gin_trgm_ops);

-- 3) Re-load interactions with enriched data
TRUNCATE rx.interactions;

\copy rx.interactions (drug_a, drug_b, severity, clinical_effect) FROM 'data/interactions.tsv' WITH (FORMAT text, NULL '');

ANALYZE rx.interactions;

-- Verify
SELECT
  COUNT(*) AS total_interactions,
  COUNT(clinical_effect) AS with_clinical_effect,
  COUNT(*) FILTER (WHERE severity = 'Major') AS major,
  COUNT(*) FILTER (WHERE severity = 'Moderate') AS moderate,
  COUNT(*) FILTER (WHERE severity = 'Minor') AS minor
FROM rx.interactions;
