import * as fs from 'fs';
import * as path from 'path';

const PRODUCTS_DIR = path.join(__dirname, '..', 'files', 'products');
const OUTPUT_FILE = path.join(__dirname, '..', 'files', 'products.json');

function mergeProducts() {
  const files = fs
    .readdirSync(PRODUCTS_DIR)
    .filter((file) => file.endsWith('.json'));

  const allProducts = files.flatMap((file) => {
    const filePath = path.join(PRODUCTS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allProducts, null, 2), 'utf-8');

  console.log(
    `Merged ${files.length} files into products.json (${allProducts.length} products)`,
  );
}

mergeProducts();
