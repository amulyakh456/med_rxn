-- Run after 01_schema.sql. Uses \copy so it works from psql with files
-- relative to this directory: node/sql/

\copy rx.medicines (id, brand_name, brand_lc, brand_family, generic_name, dosage, dosage_form, manufacturer, pack_size, price, prescription_required) FROM 'data/medicines.tsv' WITH (FORMAT text, NULL '\N');

SELECT setval(pg_get_serial_sequence('rx.medicines','id'), (SELECT max(id) FROM rx.medicines));

\copy rx.medicine_ingredients (medicine_id, ingredient, ingredient_position, ingredient_count) FROM 'data/medicine_ingredients.tsv' WITH (FORMAT text);

\copy rx.canonical_generics (ingredient, occurrence_count) FROM 'data/canonical_generics.tsv' WITH (FORMAT text);

\copy rx.india_to_ddinter_map (ingredient, ddinter_name, matched, occurrence_count) FROM 'data/india_to_ddinter_map.tsv' WITH (FORMAT text);

\copy rx.interactions (drug_a, drug_b, severity) FROM 'data/interactions.tsv' WITH (FORMAT text);

ANALYZE rx.medicines;
ANALYZE rx.medicine_ingredients;
ANALYZE rx.interactions;
