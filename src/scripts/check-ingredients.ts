import * as fs from 'fs';
import * as path from 'path';

const PRODUCTS_FILE = path.join(__dirname, '..', 'files', 'products.json');
const INGREDIENTS_FILE = path.join(__dirname, '..', 'files', 'ingredients.json');

const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf-8'));
const ingredients = JSON.parse(fs.readFileSync(INGREDIENTS_FILE, 'utf-8'));

const ingredientNames = new Set(ingredients.map((i: any) => i.name));

const productIngredients = new Set<string>();
for (const product of products) {
  for (const ing of product.ingredients || []) {
    productIngredients.add(ing.name);
  }
  for (const comp of product.comparables || []) {
    for (const ing of comp.ingredients || []) {
      productIngredients.add(ing.name);
    }
  }
}

const missing = [...productIngredients]
  .filter((name) => !ingredientNames.has(name))
  .sort();

console.log('Total unique ingredient names in products:', productIngredients.size);
console.log('Total in ingredients.json:', ingredientNames.size);
console.log(`Missing from ingredients.json (${missing.length}):`);
missing.forEach((name) => console.log(`  - ${name}`));
