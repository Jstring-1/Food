// Curated list of food additives worth flagging, based on public regulatory
// actions and assessments (EU/FDA bans, EFSA opinions, IARC classifications).
// Not a reproduction of any proprietary rating system. severity: 'avoid' | 'caution'.
// `terms` are matched (case-insensitive, whole-word) against ingredient text.
window.ADDITIVES = [
  // ── Artificial colors ─────────────────────────────────────────
  { terms: ['Red 3', 'Red No. 3', 'FD&C Red 3', 'Erythrosine', 'E127'], severity: 'avoid', note: 'Artificial dye. FDA revoked its use in food (2025); linked to cancer in animal studies.' },
  { terms: ['Red 40', 'Red No. 40', 'FD&C Red 40', 'Allura Red', 'E129'], severity: 'caution', note: 'Artificial dye linked to hyperactivity in children; EU requires a warning label.' },
  { terms: ['Yellow 5', 'Yellow No. 5', 'FD&C Yellow 5', 'Tartrazine', 'E102'], severity: 'caution', note: 'Artificial dye linked to hyperactivity/allergic reactions; EU warning label required.' },
  { terms: ['Yellow 6', 'Yellow No. 6', 'FD&C Yellow 6', 'Sunset Yellow', 'E110'], severity: 'caution', note: 'Artificial dye linked to hyperactivity; EU warning label required.' },
  { terms: ['Blue 1', 'Brilliant Blue', 'E133'], severity: 'caution', note: 'Artificial dye; some safety questions, limited testing.' },
  { terms: ['Blue 2', 'Indigotine', 'E132'], severity: 'caution', note: 'Artificial dye; inadequate long-term safety data.' },
  { terms: ['Green 3', 'Fast Green', 'E143'], severity: 'caution', note: 'Artificial dye; banned in the EU.' },
  { terms: ['Caramel color', 'Caramel coloring', 'E150d', '4-MEI', '4-methylimidazole'], severity: 'caution', note: 'Class III/IV caramel coloring can contain 4-MEI, a possible carcinogen.' },
  { terms: ['Titanium dioxide', 'E171'], severity: 'avoid', note: 'Whitener banned in the EU (2022) over genotoxicity concerns.' },
  { terms: ['Carmine', 'Cochineal', 'E120'], severity: 'caution', note: 'Insect-derived red dye; can cause severe allergic reactions.' },

  // ── Preservatives / antioxidants ──────────────────────────────
  { terms: ['Sodium nitrite', 'E250'], severity: 'avoid', note: 'Forms nitrosamines; processed meats classified carcinogenic to humans (IARC Group 1).' },
  { terms: ['Sodium nitrate', 'Potassium nitrate', 'E251', 'E252'], severity: 'avoid', note: 'Converts to nitrite; associated with processed-meat cancer risk.' },
  { terms: ['BHA', 'Butylated hydroxyanisole', 'E320'], severity: 'avoid', note: 'Preservative classified as possibly carcinogenic to humans (IARC 2B).' },
  { terms: ['BHT', 'Butylated hydroxytoluene', 'E321'], severity: 'caution', note: 'Preservative with conflicting animal cancer data.' },
  { terms: ['TBHQ', 'tert-Butylhydroquinone', 'E319'], severity: 'caution', note: 'Preservative; immune/animal-study concerns at higher doses.' },
  { terms: ['Propyl gallate', 'E310'], severity: 'caution', note: 'Preservative with limited and conflicting safety data.' },
  { terms: ['Potassium bromate', 'E924'], severity: 'avoid', note: 'Flour treatment; possible carcinogen, banned in the EU, UK, Canada and others.' },
  { terms: ['Azodicarbonamide', 'E927a'], severity: 'avoid', note: 'Dough conditioner banned in the EU and Australia.' },
  { terms: ['Sodium benzoate', 'Benzoic acid', 'E211', 'E210'], severity: 'caution', note: 'Can form benzene (a carcinogen) when combined with vitamin C.' },
  { terms: ['Sulfur dioxide', 'Sodium sulfite', 'Sodium bisulfite', 'Sodium metabisulfite', 'Potassium metabisulfite', 'Sulfites', 'E220', 'E221', 'E222', 'E223', 'E224'], severity: 'caution', note: 'Preservative that can trigger asthma and allergic reactions.' },
  { terms: ['Propylparaben', 'E216'], severity: 'caution', note: 'Preservative with endocrine-disruption concerns; restricted in the EU.' },

  // ── Fats / oils ───────────────────────────────────────────────
  { terms: ['Partially hydrogenated', 'Hydrogenated oil', 'Trans fat'], severity: 'avoid', note: 'Source of artificial trans fat; banned by the FDA and WHO-targeted for elimination.' },
  { terms: ['Brominated vegetable oil', 'BVO', 'E443'], severity: 'avoid', note: 'Emulsifier; FDA revoked authorization (2024) over health concerns.' },

  // ── Emulsifiers / thickeners ──────────────────────────────────
  { terms: ['Carrageenan', 'E407'], severity: 'caution', note: 'Thickener linked to gut inflammation in some studies.' },
  { terms: ['Polysorbate 80', 'E433', 'Polysorbate 60', 'E435'], severity: 'caution', note: 'Emulsifier; emerging research links some emulsifiers to gut-microbiome disruption.' },
  { terms: ['Carboxymethylcellulose', 'Cellulose gum', 'E466'], severity: 'caution', note: 'Emulsifier with emerging gut-microbiome concerns.' },

  // ── Flavor enhancers / sweeteners ─────────────────────────────
  { terms: ['Monosodium glutamate', 'MSG', 'E621'], severity: 'caution', note: 'Flavor enhancer; generally recognized as safe but can cause sensitivity reactions.' },
  { terms: ['Aspartame', 'E951'], severity: 'caution', note: 'Sweetener classified as possibly carcinogenic to humans (IARC 2B, 2023).' },
  { terms: ['Acesulfame potassium', 'Acesulfame K', 'Ace-K', 'E950'], severity: 'caution', note: 'Artificial sweetener with limited long-term safety data.' },
  { terms: ['Sucralose', 'E955'], severity: 'caution', note: 'Artificial sweetener; recent studies raise genotoxicity/gut questions.' },
  { terms: ['Saccharin', 'E954'], severity: 'caution', note: 'Artificial sweetener with historical (since-disputed) cancer concerns.' },
  { terms: ['High fructose corn syrup', 'HFCS', 'Glucose-fructose syrup'], severity: 'caution', note: 'Added sugar tied to obesity and metabolic disease when consumed in excess.' },
];
