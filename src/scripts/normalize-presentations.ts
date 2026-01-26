import * as fs from 'fs';
import * as path from 'path';

const PRODUCTS_DIR = path.join(__dirname, '..', 'files', 'products');

const PRESENTATION_MAP: Record<string, string> = {
  // cucharadas
  cucharadas: 'cucharadas',
  CUCHARADAS: 'cucharadas',
  'CUCHARA DOSIF': 'cucharadas',
  'CUCHARA DOSIS': 'cucharadas',

  // cápsulas
  'cápsulas': 'cápsulas',
  capsulas: 'cápsulas',
  caps: 'cápsulas',
  CAPS: 'cápsulas',
  cap: 'cápsulas',
  CAP: 'cápsulas',
  CAPSULA: 'cápsulas',

  // tabletas
  tabletas: 'tabletas',
  tab: 'tabletas',
  tabs: 'tabletas',

  // softgel
  softgel: 'softgel',
  softgels: 'softgel',

  // gotas
  gotas: 'gotas',
  GOTAS: 'gotas',
  GOTA: 'gotas',

  // sobre
  sobre: 'sobre',
  sobres: 'sobre',

  // vial
  vial: 'vial',
  viales: 'vial',

  // mililitro
  mililitro: 'mililitro',
  ml: 'mililitro',
  ML: 'mililitro',

  // push
  push: 'push',
  PUSH: 'push',

  // dosis
  dosis: 'dosis',

  // ampollas
  ampollas: 'ampollas',

  // gomas
  gomas: 'gomas',

  // sticks
  sticks: 'sticks',
};

function run() {
  const files = fs
    .readdirSync(PRODUCTS_DIR)
    .filter((file) => file.endsWith('.json'));

  let filesFixed = 0;
  const unmapped = new Set<string>();

  for (const file of files) {
    const filePath = path.join(PRODUCTS_DIR, file);
    const original = fs.readFileSync(filePath, 'utf-8');
    const products = JSON.parse(original);

    for (const product of products) {
      if (product.presentation) {
        const mapped = PRESENTATION_MAP[product.presentation];
        if (mapped) {
          if (product.presentation !== mapped) {
            console.log(`  ${file}: "${product.presentation}" -> "${mapped}"`);
            product.presentation = mapped;
          }
        } else {
          unmapped.add(product.presentation);
        }
      }

      for (const comp of product.comparables || []) {
        if (comp.presentation) {
          const mapped = PRESENTATION_MAP[comp.presentation];
          if (mapped) {
            if (comp.presentation !== mapped) {
              console.log(`  ${file} (comp): "${comp.presentation}" -> "${mapped}"`);
              comp.presentation = mapped;
            }
          } else {
            unmapped.add(comp.presentation);
          }
        }
      }
    }

    const updated = JSON.stringify(products, null, 2);
    if (original !== updated) {
      fs.writeFileSync(filePath, updated, 'utf-8');
      filesFixed++;
    }
  }

  console.log(`\nNormalized presentations in ${filesFixed} product files`);
  if (unmapped.size > 0) {
    console.log(`\nUnmapped presentation values:`);
    [...unmapped].forEach((v) => console.log(`  - "${v}"`));
  }
}

run();
