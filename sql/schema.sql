-- Food & nutrition database schema (PostgreSQL)
-- Two source-of-truth sets of tables: USDA FoodData Central (fdc_*) and
-- Open Food Facts (off_*). Kept separate on purpose — their data models and
-- licenses differ. Build a unified view on top once query patterns are clear.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ──────────────────────────────────────────────────────────────────────────
-- USDA FoodData Central  (public domain)
--   Dumps: https://fdc.nal.usda.gov/download-datasets  (CSV "Full Download")
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fdc_food (
  fdc_id            INTEGER PRIMARY KEY,
  data_type         TEXT NOT NULL,          -- foundation_food | sr_legacy_food | branded_food | survey_fndds_food
  description       TEXT,                    -- nullable: some branded_food rows have no description
  food_category     TEXT,                    -- resolved from food_category.csv at ingest
  publication_date  DATE,
  -- Denormalized common macros (per 100 g), populated from fdc_food_nutrient
  -- after load (npm run denormalize:fdc). Lets search filter/sort without
  -- joining the 27M-row fdc_food_nutrient table.
  energy_kcal_100g  DOUBLE PRECISION,
  protein_100g      DOUBLE PRECISION,
  sugars_100g       DOUBLE PRECISION,
  fat_100g          DOUBLE PRECISION
);

-- Fix already-created tables (CREATE TABLE IF NOT EXISTS won't alter them).
ALTER TABLE fdc_food ALTER COLUMN description DROP NOT NULL;
ALTER TABLE fdc_food ADD COLUMN IF NOT EXISTS energy_kcal_100g DOUBLE PRECISION;
ALTER TABLE fdc_food ADD COLUMN IF NOT EXISTS protein_100g     DOUBLE PRECISION;
ALTER TABLE fdc_food ADD COLUMN IF NOT EXISTS sugars_100g      DOUBLE PRECISION;
ALTER TABLE fdc_food ADD COLUMN IF NOT EXISTS fat_100g         DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS fdc_nutrient (
  id            INTEGER PRIMARY KEY,         -- nutrient.csv id (NOT the older nutrient_nbr)
  name          TEXT NOT NULL,
  unit_name     TEXT,                        -- G | MG | UG | KCAL | ...
  nutrient_nbr  TEXT
);

-- No composite PK: FDC ships duplicate (fdc_id, nutrient_id) pairs (same
-- nutrient via different derivations). Index on fdc_id backs the label lookup.
CREATE TABLE IF NOT EXISTS fdc_food_nutrient (
  fdc_id        INTEGER NOT NULL REFERENCES fdc_food(fdc_id) ON DELETE CASCADE,
  nutrient_id   INTEGER NOT NULL REFERENCES fdc_nutrient(id),
  amount        DOUBLE PRECISION             -- amount per 100 g/ml of the food
);

-- Drop the old composite PK on tables created before this change.
ALTER TABLE fdc_food_nutrient DROP CONSTRAINT IF EXISTS fdc_food_nutrient_pkey;

CREATE TABLE IF NOT EXISTS fdc_branded (
  fdc_id                 INTEGER PRIMARY KEY REFERENCES fdc_food(fdc_id) ON DELETE CASCADE,
  brand_owner            TEXT,
  brand_name             TEXT,
  gtin_upc               TEXT,
  ingredients            TEXT,
  serving_size           DOUBLE PRECISION,
  serving_size_unit      TEXT,
  household_serving      TEXT,
  branded_food_category  TEXT
);

CREATE INDEX IF NOT EXISTS fdc_food_nutrient_fdc_idx ON fdc_food_nutrient (fdc_id);
CREATE INDEX IF NOT EXISTS fdc_food_kcal_idx ON fdc_food (energy_kcal_100g);
CREATE INDEX IF NOT EXISTS fdc_branded_gtin_idx ON fdc_branded (gtin_upc);
CREATE INDEX IF NOT EXISTS fdc_food_datatype_idx ON fdc_food (data_type);
CREATE INDEX IF NOT EXISTS fdc_food_desc_trgm ON fdc_food USING gin (description gin_trgm_ops);

-- ──────────────────────────────────────────────────────────────────────────
-- Open Food Facts  (ODbL — attribution + share-alike on redistribution)
--   Dumps: https://world.openfoodfacts.org/data  (Parquet export: food.parquet)
-- Common macros are flattened into columns at ingest (all per 100 g/ml).
-- The full per-nutrient blob (nutriments) is opt-in — set OFF_NUTRIMENTS_JSON=1
-- before ingest. It is large (~8 GB across the full dump); off by default.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS off_product (
  code                TEXT PRIMARY KEY,        -- barcode (EAN/UPC)
  product_name        TEXT,
  brands              TEXT,
  categories          TEXT,
  quantity            TEXT,
  serving_size        TEXT,
  ingredients_text    TEXT,
  nutriscore_grade    TEXT,                    -- a..e | unknown | not-applicable
  nova_group          SMALLINT,                -- 1..4 (processing level)
  countries           TEXT,                    -- comma-joined country tags
  energy_kcal_100g    DOUBLE PRECISION,
  proteins_100g       DOUBLE PRECISION,
  fat_100g            DOUBLE PRECISION,
  saturated_fat_100g  DOUBLE PRECISION,
  carbohydrates_100g  DOUBLE PRECISION,
  sugars_100g         DOUBLE PRECISION,
  fiber_100g          DOUBLE PRECISION,
  salt_100g           DOUBLE PRECISION,
  sodium_100g         DOUBLE PRECISION,
  -- Common micronutrients (per 100 g, stored in grams as OFF provides them).
  vitamin_d_100g      DOUBLE PRECISION,
  calcium_100g        DOUBLE PRECISION,
  iron_100g           DOUBLE PRECISION,
  potassium_100g      DOUBLE PRECISION,
  vitamin_c_100g      DOUBLE PRECISION,
  nutriments          JSONB,                   -- full nutrient array; null unless OFF_NUTRIMENTS_JSON=1
  last_modified       TIMESTAMPTZ
);

ALTER TABLE off_product ADD COLUMN IF NOT EXISTS vitamin_d_100g DOUBLE PRECISION;
ALTER TABLE off_product ADD COLUMN IF NOT EXISTS calcium_100g   DOUBLE PRECISION;
ALTER TABLE off_product ADD COLUMN IF NOT EXISTS iron_100g      DOUBLE PRECISION;
ALTER TABLE off_product ADD COLUMN IF NOT EXISTS potassium_100g DOUBLE PRECISION;
ALTER TABLE off_product ADD COLUMN IF NOT EXISTS vitamin_c_100g DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS off_name_trgm ON off_product USING gin (product_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS off_brands_idx ON off_product USING gin (brands gin_trgm_ops);
