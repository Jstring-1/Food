// Shared recipe-ingredient text/filter constants, used by the API server and by
// the maintenance backfill so they can never drift out of sync.

// Meat / fish / shellfish lexemes for the vegetarian filter (dairy & eggs are
// allowed). Single words, stemmed by to_tsquery; OR-joined into one tsquery.
export const NONVEG_TERMS = [
  'beef', 'steak', 'brisket', 'veal', 'pork', 'ham', 'hamburger', 'bacon', 'sausage', 'pepperoni',
  'salami', 'prosciutto', 'pancetta', 'chorizo', 'bratwurst', 'frankfurter', 'bologna', 'hotdog',
  'chicken', 'turkey', 'duck', 'goose', 'quail', 'hen', 'poultry', 'giblets', 'lamb', 'mutton',
  'goat', 'venison', 'bison', 'rabbit', 'liver', 'foie',
  'fish', 'salmon', 'tuna', 'cod', 'tilapia', 'halibut', 'trout', 'sardine', 'anchovy', 'anchovies',
  'mackerel', 'herring', 'snapper', 'catfish', 'swordfish', 'shrimp', 'prawn', 'prawns', 'crab',
  'crabmeat', 'lobster', 'crawfish', 'crayfish', 'clam', 'mussel', 'mussels', 'oyster', 'oysters', 'scallop',
  'scallops', 'squid', 'octopus', 'calamari', 'escargot', 'snail', 'caviar', 'seafood', 'shellfish',
  'gelatin', 'gelatine', 'lard', 'suet', 'tallow', 'worcestershire',
];
export const NONVEG_TSQUERY = NONVEG_TERMS.join(' | ');

// FTS over ingredients. The source text contains literal "\t" escapes and often
// omits spaces around punctuation ("lb.shrimp,peeled"), which the default parser
// would glue into one un-matchable token. So we first strip backslash-escapes
// ('\\[a-zA-Z]'), then turn any non-letter run into a space. The ingredient
// search and the GIN index must use this exact text.
export const ING_TSV =
  `to_tsvector('english', regexp_replace(regexp_replace(ingredients::text, '\\\\[a-zA-Z]', ' ', 'g'), '[^[:alpha:]]+', ' ', 'g'))`;
