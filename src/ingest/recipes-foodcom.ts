// Ingest the Food.com / Kaggle recipe dataset into the recipe table.
//
//   1. Download "Food.com Recipes and Interactions" from Kaggle:
//      https://www.kaggle.com/datasets/shuyangli94/food-com-recipes-and-user-interactions
//   2. Put RAW_recipes.csv (and optionally RAW_interactions.csv for ratings)
//      in ./data/recipes/  (or set FOODCOM_RECIPES / FOODCOM_INTERACTIONS).
//   3. npm run db:migrate        (once, creates the recipe table)
//   4. npm run ingest:recipes:foodcom
//
// Full refresh of source='foodcom' rows only (RecipeNLG rows are untouched).
import 'dotenv/config';
import { createReadStream, existsSync } from 'node:fs';
import { parse } from 'csv-parse';
import pgCopy from 'pg-copy-streams';
import { pool } from '../db.js';
import { row, write, end, parseList } from './util.js';

const { from: copyFrom } = pgCopy;
const RECIPES = process.env.FOODCOM_RECIPES ?? './data/recipes/RAW_recipes.csv';
const INTERACTIONS = process.env.FOODCOM_INTERACTIONS ?? './data/recipes/RAW_interactions.csv';

// Food.com nutrition cell: [calories, total fat PDV, sugar PDV, sodium PDV,
// protein PDV, saturated fat PDV, carbohydrates PDV]. Reverse the %DV to grams
// using FDA Daily Values (approximate; the dataset is %DV not grams).
const DV = { fat: 78, sugar: 50, sodium: 2300, protein: 50, satFat: 20, carbs: 275 };
function nutrition(cell: string) {
  const nums = (cell || '').replace(/[[\]]/g, '').split(',').map((x) => Number(x.trim()));
  if (nums.length < 7 || nums.some((x) => !Number.isFinite(x))) {
    return { calories: null, fat: null, sugar: null, sodium: null, protein: null, satFat: null, carbs: null };
  }
  const pct = (p: number, dv: number) => +((p / 100) * dv).toFixed(1);
  return {
    calories: +nums[0].toFixed(0),
    fat: pct(nums[1], DV.fat),
    sugar: pct(nums[2], DV.sugar),
    sodium: pct(nums[3], DV.sodium),
    protein: pct(nums[4], DV.protein),
    satFat: pct(nums[5], DV.satFat),
    carbs: pct(nums[6], DV.carbs),
  };
}

const slug = (name: string) =>
  (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// Pre-aggregate user ratings (RAW_interactions.csv) → avg + count per recipe.
async function loadRatings(): Promise<Map<string, { avg: number; count: number }>> {
  const out = new Map<string, { sum: number; count: number }>();
  if (!existsSync(INTERACTIONS)) {
    console.log('  (no RAW_interactions.csv — skipping ratings)');
    return new Map();
  }
  const parser = createReadStream(INTERACTIONS).pipe(
    parse({ columns: true, relax_quotes: true, skip_records_with_error: true }),
  );
  for await (const r of parser as AsyncIterable<Record<string, string>>) {
    const id = r.recipe_id;
    const rating = Number(r.rating);
    if (!id || !Number.isFinite(rating)) continue;
    const e = out.get(id) ?? { sum: 0, count: 0 };
    e.sum += rating; e.count += 1;
    out.set(id, e);
  }
  const agg = new Map<string, { avg: number; count: number }>();
  for (const [id, e] of out) agg.set(id, { avg: +(e.sum / e.count).toFixed(2), count: e.count });
  console.log(`  ratings for ${agg.size.toLocaleString()} recipes`);
  return agg;
}

async function main() {
  if (!existsSync(RECIPES)) throw new Error(`Missing ${RECIPES} (set FOODCOM_RECIPES)`);
  console.log(`Ingesting Food.com recipes from ${RECIPES}`);

  const ratings = await loadRatings();
  await pool.query(`DELETE FROM recipe WHERE source = 'foodcom'`);

  const client = await pool.connect();
  try {
    const dest = client.query(copyFrom(
      `COPY recipe (source, source_id, title, ingredients, steps, tags, minutes, n_ingredients,
        source_url, description, rating, review_count,
        calories, fat_g, sat_fat_g, sugar_g, sodium_mg, protein_g, carbs_g)
       FROM STDIN WITH (FORMAT text)`));
    const parser = createReadStream(RECIPES).pipe(
      parse({ columns: true, relax_quotes: true, skip_records_with_error: true }),
    );
    let n = 0;
    for await (const r of parser as AsyncIterable<Record<string, string>>) {
      if (!r.name || !r.id) continue;
      const nut = nutrition(r.nutrition);
      const rt = ratings.get(r.id);
      await write(dest, row(
        'foodcom', r.id, r.name,
        JSON.stringify(parseList(r.ingredients)),
        JSON.stringify(parseList(r.steps)),
        JSON.stringify(parseList(r.tags)),
        r.minutes || null, r.n_ingredients || null,
        `https://www.food.com/recipe/${slug(r.name)}-${r.id}`,
        r.description || null,
        rt ? rt.avg : null, rt ? rt.count : null,
        nut.calories, nut.fat, nut.satFat, nut.sugar, nut.sodium, nut.protein, nut.carbs,
      ));
      if (++n % 50_000 === 0) console.log(`  recipes: ${n.toLocaleString()}`);
    }
    await end(dest);
    console.log(`  recipes: ${n.toLocaleString()} (done)`);
  } finally {
    client.release();
  }

  await pool.query('ANALYZE recipe');
  await pool.end();
  console.log('Food.com ingest complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
