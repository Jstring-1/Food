// Ingest the Food.com recipes dataset (Irkaal "Food.com - Recipes and Reviews")
// into the recipe table.
//
//   1. Download from Kaggle ("food-com-recipes-and-reviews"); it ships recipes.csv.
//   2. Put recipes.csv in ./data/recipes/  (or set FOODCOM_RECIPES).
//   3. npm run db:migrate        (once, creates/updates the recipe table)
//   4. npm run ingest:recipes:foodcom
//
// This dataset has real per-serving nutrition in grams/mg, categories, images,
// and pre-aggregated ratings. List columns use R-vector syntax: c("a", "b").
// Full refresh of source='foodcom' rows only (RecipeNLG rows are untouched).
import 'dotenv/config';
import { createReadStream, existsSync } from 'node:fs';
import { parse } from 'csv-parse';
import pgCopy from 'pg-copy-streams';
import { pool } from '../db.js';
import { row, write, end, parseList } from './util.js';

const { from: copyFrom } = pgCopy;
const RECIPES = process.env.FOODCOM_RECIPES ?? './data/recipes/recipes.csv';

// "NA"/empty/non-numeric → null; otherwise the number.
const num = (v: string | undefined): number | null => {
  if (v == null) return null;
  const s = v.trim();
  if (!s || s === 'NA') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// ISO-8601 duration (PT24H45M / PT45M / P1DT2H) → total minutes.
function minutes(v: string | undefined): number | null {
  const m = (v || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return null;
  const mins = (Number(m[1] || 0) * 1440) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  return mins > 0 ? mins : null;
}

const slug = (name: string) =>
  (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// Combine quantities + ingredient names into readable lines ("4 blueberries").
function ingredients(qty: string | undefined, parts: string | undefined): string[] {
  const q = parseList(qty);
  const p = parseList(parts);
  return p.map((name, i) => (q[i] && q[i] !== 'NA' ? `${q[i]} ${name}` : name));
}

function image(v: string | undefined): string | null {
  const imgs = parseList(v);
  if (imgs.length) return imgs[0];
  const s = (v || '').trim();
  return /^https?:\/\//.test(s) ? s : null;
}

async function main() {
  if (!existsSync(RECIPES)) throw new Error(`Missing ${RECIPES} (set FOODCOM_RECIPES)`);
  console.log(`Ingesting Food.com recipes from ${RECIPES}`);

  await pool.query(`DELETE FROM recipe WHERE source = 'foodcom'`);

  const client = await pool.connect();
  try {
    const dest = client.query(copyFrom(
      `COPY recipe (source, source_id, title, ingredients, steps, tags, minutes, n_ingredients,
        source_url, image, category, description, rating, review_count,
        calories, fat_g, sat_fat_g, cholesterol_mg, sodium_mg, carbs_g, fiber_g, sugar_g, protein_g)
       FROM STDIN WITH (FORMAT text)`));
    const parser = createReadStream(RECIPES).pipe(
      parse({ columns: true, relax_quotes: true, skip_records_with_error: true }),
    );
    let n = 0;
    for await (const r of parser as AsyncIterable<Record<string, string>>) {
      const title = r.Name?.trim();
      if (!title || !r.RecipeId) continue;
      const ing = ingredients(r.RecipeIngredientQuantities, r.RecipeIngredientParts);
      await write(dest, row(
        'foodcom', r.RecipeId, title,
        JSON.stringify(ing),
        JSON.stringify(parseList(r.RecipeInstructions)),
        JSON.stringify(parseList(r.Keywords)),
        minutes(r.TotalTime) ?? minutes(r.PrepTime),
        ing.length || null,
        `https://www.food.com/recipe/${slug(title)}-${r.RecipeId}`,
        image(r.Images),
        r.RecipeCategory && r.RecipeCategory !== 'NA' ? r.RecipeCategory : null,
        r.Description && r.Description !== 'NA' ? r.Description : null,
        num(r.AggregatedRating), num(r.ReviewCount),
        num(r.Calories), num(r.FatContent), num(r.SaturatedFatContent), num(r.CholesterolContent),
        num(r.SodiumContent), num(r.CarbohydrateContent), num(r.FiberContent), num(r.SugarContent),
        num(r.ProteinContent),
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
