import * as fs from 'fs';
import * as path from 'path';

const INGREDIENTS_FILE = path.join(__dirname, '..', 'files', 'ingredients.json');
const PRODUCTS_DIR = path.join(__dirname, '..', 'files', 'products');

// 1. Uppercase all ingredient names in ingredients.json
const ingredients = JSON.parse(fs.readFileSync(INGREDIENTS_FILE, 'utf-8'));
const updated = ingredients.map((ing: any) => ({
  ...ing,
  name: ing.name.toUpperCase(),
}));
fs.writeFileSync(INGREDIENTS_FILE, JSON.stringify(updated, null, 2), 'utf-8');
console.log(`Uppercased ${updated.length} ingredient names in ingredients.json`);

// 2. Uppercase all ingredient names in product files
const files = fs
  .readdirSync(PRODUCTS_DIR)
  .filter((file) => file.endsWith('.json'));

let filesFixed = 0;
for (const file of files) {
  const filePath = path.join(PRODUCTS_DIR, file);
  const original = fs.readFileSync(filePath, 'utf-8');
  const products = JSON.parse(original);

  for (const product of products) {
    if (product.ingredients) {
      product.ingredients = product.ingredients.map((ing: any) => ({
        ...ing,
        name: ing.name.toUpperCase(),
      }));
    }
    if (product.comparables) {
      for (const comp of product.comparables) {
        if (comp.ingredients) {
          comp.ingredients = comp.ingredients.map((ing: any) => ({
            ...ing,
            name: ing.name.toUpperCase(),
          }));
        }
      }
    }
  }

  const updatedContent = JSON.stringify(products, null, 2);
  if (original !== updatedContent) {
    fs.writeFileSync(filePath, updatedContent, 'utf-8');
    filesFixed++;
  }
}

console.log(`Uppercased ingredient names in ${filesFixed} product files`);
