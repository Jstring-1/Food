// Populate fdc_food's denormalized macro columns (energy_kcal_100g,
// protein_100g, sugars_100g, fat_100g) from fdc_food_nutrient in one pass, so
// search can filter/sort without joining the 27M-row nutrient table.
//
//   npm run denormalize:fdc
//
// Safe to re-run; also invoked automatically at the end of npm run ingest:fdc.
import { pool } from '../db.js';

// Standard FDC nutrient.id values. Energy has a kcal (1008) and kJ (1062)
// variant — we want kcal. Sugars appears as 2000 / 1063 across dump versions.
const IDS = {
  kcal: [1008],
  protein: [1003],
  sugars: [2000, 1063],
  fat: [1004],
};

export async function denormalizeFdc(): Promise<void> {
  const all = [...IDS.kcal, ...IDS.protein, ...IDS.sugars, ...IDS.fat];
  console.log('Aggregating macros from fdc_food_nutrient and updating fdc_food…');
  const res = await pool.query(
    `UPDATE fdc_food f SET
        energy_kcal_100g = n.kcal,
        protein_100g     = n.protein,
        sugars_100g      = n.sugars,
        fat_100g         = n.fat
       FROM (
         SELECT fdc_id,
                max(amount) FILTER (WHERE nutrient_id = ANY($1)) AS kcal,
                max(amount) FILTER (WHERE nutrient_id = ANY($2)) AS protein,
                max(amount) FILTER (WHERE nutrient_id = ANY($3)) AS sugars,
                max(amount) FILTER (WHERE nutrient_id = ANY($4)) AS fat
           FROM fdc_food_nutrient
          WHERE nutrient_id = ANY($5)
          GROUP BY fdc_id
       ) n
      WHERE n.fdc_id = f.fdc_id`,
    [IDS.kcal, IDS.protein, IDS.sugars, IDS.fat, all],
  );
  console.log(`updated ${(res.rowCount ?? 0).toLocaleString()} foods`);
  await pool.query('VACUUM ANALYZE fdc_food');
}
