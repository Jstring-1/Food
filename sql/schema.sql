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
  description       TEXT NOT NULL,
  food_category     TEXT,                    -- resolved from food_category.csv at ingest
  publication_date  DATE
);

CREATE TABLE IF NOT EXISTS fdc_nutrient (
  id            INTEGER PRIMARY KEY,         -- nutrient.csv id (NOT the older nutrient_nbr)
  name          TEXT NOT NULL,
  unit_name     TEXT,                        -- G | MG | UG | KCAL | ...
  nutrient_nbr  TEXT
);

CREATE TABLE IF NOT EXISTS fdc_food_nutrient (
  fdc_id        INTEGER NOT NULL REFERENCES fdc_food(fdc_id) ON DELETE CASCADE,
  nutrient_id   INTEGER NOT NULL REFERENCES fdc_nutrient(id),
  amount        DOUBLE PRECISION,            -- amount per 100 g/ml of the food
  PRIMARY KEY (fdc_id, nutrient_id)
);

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

CREATE INDEX IF NOT EXISTS fdc_branded_gtin_idx ON fdc_branded (gtin_upc);
CREATE INDEX IF NOT EXISTS fdc_food_datatype_idx ON fdc_food (data_type);
CREATE INDEX IF NOT EXISTS fdc_food_desc_trgm ON fdc_food USING gin (description gin_trgm_ops);

-- ──────────────────────────────────────────────────────────────────────────
-- Open Food Facts  (ODbL — attribution + share-alike on redistribution)
--   Dumps: https://world.openfoodfacts.org/data  (openfoodfacts-products.jsonl.gz)
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS off_product (
  code              TEXT PRIMARY KEY,        -- barcode (EAN/UPC)
  product_name      TEXT,
  brands            TEXT,
  categories        TEXT,
  quantity          TEXT,
  serving_size      TEXT,
  ingredients_text  TEXT,
  nutriscore_grade  TEXT,                     -- a..e
  nova_group        SMALLINT,                 -- 1..4 (processing level)
  countries         TEXT,
  nutriments        JSONB,                    -- full per-100g/serving nutrient object
  last_modified     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS off_name_trgm ON off_product USING gin (product_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS off_nutriments_idx ON off_product USING gin (nutriments);
CREATE INDEX IF NOT EXISTS off_brands_idx ON off_product USING gin (brands gin_trgm_ops);
