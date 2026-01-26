import * as fs from 'fs';
import * as path from 'path';

const PRODUCTS_DIR = path.join(__dirname, '..', 'files', 'products');

// Map of incorrect/variant brand name -> correct canonical name
const BRAND_NORMALIZATION_MAP: Record<string, string> = {
  // Typos
  'HEALTHY AMERCIA': 'HEALTHY AMERICA',
  HERSEN: 'HERSSEN',
  NUTRHAN: 'NUTRAHAN',
  NUTRVITA: 'NUTRIVITA',
  SWASON: 'SWANSON',
  'SEEKING- HEALTH': 'SEEKING HEALTH',
  'Procter Gamble': 'PROCTER & GAMBLE COLOMBIA',

  // Case mismatches
  'Healthy America': 'HEALTHY AMERICA',
  'Humax Pharmaceutical': 'HUMAX PHARMACEUTICAL SA',
  'Procter & Gamble': 'PROCTER & GAMBLE COLOMBIA',
  'OPELLA HEALTHCARE': 'OPELLA HEALTHCARE COLOMBIA',

  // Apostrophe variant (´ vs ')
  "FITO MEDIC\u00B4S": "FITO MEDIC'S",
  "NATURE\u00B4S BOUNTY": "NATURE'S BOUNTY",

  // Main brand name mismatch
  NUTRABIOTICS: 'NUTRIBIOTICS',

  // Placeholders -> empty string
  Desconocido: '',
  'No especificado': '',
};

// Special fix: DK-MULSIÓN.json has swapped name/brandName for FARMA D
const SWAP_FIXES: Array<{
  file: string;
  oldName: string;
  oldBrand: string;
  newName: string;
  newBrand: string;
}> = [
  {
    file: 'DK-MULSIÓN.json',
    oldName: 'FARMA D',
    oldBrand: 'VITAMINA D3 5000 UI',
    newName: 'VITAMINA D3 5000 UI',
    newBrand: 'FARMA D',
  },
];

function run() {
  const files = fs
    .readdirSync(PRODUCTS_DIR)
    .filter((file) => file.endsWith('.json'));

  let filesFixed = 0;

  for (const file of files) {
    const filePath = path.join(PRODUCTS_DIR, file);
    const original = fs.readFileSync(filePath, 'utf-8');
    const products = JSON.parse(original);

    for (const product of products) {
      // Normalize main product brand
      if (product.brandName && BRAND_NORMALIZATION_MAP[product.brandName] !== undefined) {
        console.log(`  ${file}: brandName "${product.brandName}" -> "${BRAND_NORMALIZATION_MAP[product.brandName]}"`);
        product.brandName = BRAND_NORMALIZATION_MAP[product.brandName];
      }

      for (const comp of product.comparables || []) {
        // Check for swap fixes
        const swap = SWAP_FIXES.find(
          (s) =>
            s.file === file &&
            comp.name === s.oldName &&
            comp.brandName === s.oldBrand,
        );
        if (swap) {
          console.log(`  ${file}: SWAP name "${comp.name}" <-> brandName "${comp.brandName}"`);
          comp.name = swap.newName;
          comp.brandName = swap.newBrand;
        }

        // Normalize comparable brand
        if (comp.brandName && BRAND_NORMALIZATION_MAP[comp.brandName] !== undefined) {
          console.log(`  ${file}: comparable brandName "${comp.brandName}" -> "${BRAND_NORMALIZATION_MAP[comp.brandName]}"`);
          comp.brandName = BRAND_NORMALIZATION_MAP[comp.brandName];
        }
      }
    }

    const updated = JSON.stringify(products, null, 2);
    if (original !== updated) {
      fs.writeFileSync(filePath, updated, 'utf-8');
      filesFixed++;
    }
  }

  console.log(`\nNormalized brand names in ${filesFixed} product files`);
}

run();
