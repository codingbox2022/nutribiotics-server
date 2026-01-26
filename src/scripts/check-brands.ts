import * as fs from 'fs';
import * as path from 'path';

const PRODUCTS_FILE = path.join(__dirname, '..', 'files', 'products.json');
const BRANDS_FILE = path.join(__dirname, '..', 'files', 'brands.json');

const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf-8'));
const brands = JSON.parse(fs.readFileSync(BRANDS_FILE, 'utf-8'));

const brandNames = new Set<string>(brands.map((b: any) => b.name));

const productBrands = new Set<string>();
for (const product of products) {
  if (product.brandName) productBrands.add(product.brandName);
  for (const comp of product.comparables || []) {
    if (comp.brandName) productBrands.add(comp.brandName);
  }
}

// Find missing brands
const missing = [...productBrands]
  .filter((name) => !brandNames.has(name))
  .sort();

// Find close matches for missing brands (potential typos)
function findCloseMatch(name: string, candidates: Set<string>): string | null {
  const upper = name.toUpperCase();
  for (const c of candidates) {
    if (c.toUpperCase() === upper) return c;
    // Simple similarity: check if one contains the other
    if (
      c.toUpperCase().includes(upper) ||
      upper.includes(c.toUpperCase())
    )
      return c;
  }
  return null;
}

console.log('Total unique brand names in products:', productBrands.size);
console.log('Total in brands.json:', brandNames.size);
console.log(`\nMissing from brands.json (${missing.length}):`);
for (const name of missing) {
  const match = findCloseMatch(name, brandNames);
  if (match) {
    console.log(`  - "${name}" -> possible match: "${match}"`);
  } else {
    console.log(`  - "${name}" (NEW)`);
  }
}

console.log('\nAll brand names found in products:');
[...productBrands].sort().forEach((name) => {
  const inBrands = brandNames.has(name) ? '✓' : '✗';
  console.log(`  ${inBrands} ${name}`);
});
