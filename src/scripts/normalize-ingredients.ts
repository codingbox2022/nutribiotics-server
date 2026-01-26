import * as fs from 'fs';
import * as path from 'path';

const PRODUCTS_DIR = path.join(__dirname, '..', 'files', 'products');

// Map of incorrect/variant name -> correct canonical name
const NORMALIZATION_MAP: Record<string, string> = {
  'ALOE VERA': 'Aloe Vera',
  'Acido Ascorbico': 'Ácido Ascórbico',
  'Acido Folico': 'Ácido Fólico',
  'Acido Tioctico': 'Ácido Tióctico',
  'Ácido Tioctico': 'Ácido Tióctico',
  Aswagandha: 'Ashwagandha',
  BETAINA: 'Betaína',
  'Bifidobacterium animalis': 'Bifidobacterium Animalis',
  Canabidol: 'Cannabidiol',
  'D-Ribos': 'D-Ribosa',
  'D-Ribose': 'D-Ribosa',
  Glicina: 'glicina',
  'Harpagósodio': 'Harpagósido',
  'L-GLUTAMINA': 'L-glutamina',
  'L-Glutamina': 'L-glutamina',
  'L.GLUTAMINA': 'L-glutamina',
  'L-TIROSINA': 'L-Tirosina',
  'Lactobacillus casei': 'Lactobacillus Casei',
  'Lactobacillus helveticus': 'Lactobacillus Helveticus',
  'Lactobacillus rhamnosus': 'Lactobacillus Rhamnosus',
  Lipidos: 'Lípidos',
  MAGNESIO: 'Magnesio',
  PEPSINA: 'Pepsina',
  'Polvo de hojas de sen': 'Polvo Hojas Sen',
  'Polvo de raíz de ruibarbo': 'Polvo Raíz Ruibarbo',
  'Polvo de semillas de ispágula': 'Polvo Semillas Ispágula',
  Proteinas: 'Proteínas',
  'Psyllium husk': 'Psyllium Husk',
  Quercitina: 'Quercetina',
  REGALIZ: 'Regaliz',
  'VITAM C': 'Vitamina C',
  'VITAMINA A': 'Vitamina A',
  'VITAMINA D3': 'Vitamina D3',
  'VITAMINA K2': 'Vitamina K2',
  ZINA: 'Zinc',
  'Ácido Glutámico': 'Ácido glutámico',
  'Extracto seco de corteza de cáscara sagrada':
    'Extracto Corteza Cáscara Sagrada',
  'Extracto seco de Harpagophytum procumbens DC 12%':
    'Extracto Harpagophytum',
  'Extracto seco de Harpagophytum procumbens L': 'Extracto Harpagophytum',
  'Harpagophytum procumbens': 'Extracto Harpagophytum',
  'Menta piperito': 'Menta piperita',
};

function normalizeIngredientName(name: string): string {
  return NORMALIZATION_MAP[name] || name;
}

function normalizeProduct(product: any): any {
  if (product.ingredients) {
    product.ingredients = product.ingredients.map((ing: any) => ({
      ...ing,
      name: normalizeIngredientName(ing.name),
    }));
  }
  if (product.comparables) {
    product.comparables = product.comparables.map((comp: any) => {
      if (comp.ingredients) {
        comp.ingredients = comp.ingredients.map((ing: any) => ({
          ...ing,
          name: normalizeIngredientName(ing.name),
        }));
      }
      // Also normalize if a comparable's name field matches (like Harpagósodio)
      if (comp.name && NORMALIZATION_MAP[comp.name]) {
        comp.name = NORMALIZATION_MAP[comp.name];
      }
      return comp;
    });
  }
  return product;
}

function run() {
  const files = fs
    .readdirSync(PRODUCTS_DIR)
    .filter((file) => file.endsWith('.json'));

  let totalFixes = 0;

  for (const file of files) {
    const filePath = path.join(PRODUCTS_DIR, file);
    const original = fs.readFileSync(filePath, 'utf-8');
    const products = JSON.parse(original);
    const normalized = products.map(normalizeProduct);
    const updated = JSON.stringify(normalized, null, 2);

    if (original !== updated) {
      fs.writeFileSync(filePath, updated, 'utf-8');
      totalFixes++;
      console.log(`Fixed: ${file}`);
    }
  }

  console.log(`\nNormalized ingredient names in ${totalFixes} files`);
}

run();
