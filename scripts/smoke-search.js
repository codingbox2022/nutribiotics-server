/*
 * Manual live test for GoogleSearchPriceFetcher (the 'search' strategy):
 * Gemini + google_search grounding, no browser, no DB.
 * Usage: node scripts/smoke-search.js
 */
require('dotenv').config();
const {
  GoogleSearchPriceFetcher,
} = require('../dist/queues/price-fetchers/google-search-price.fetcher');

(async () => {
  const fetcher = new GoogleSearchPriceFetcher();
  const marketplace = {
    name: 'Mercado Libre Colombia',
    baseUrl: 'https://www.mercadolibre.com.co',
    country: 'Colombia',
    ivaRate: 0.19,
    scanStrategy: 'search',
  };
  const product = { name: 'Centrum Mujer 30 tabletas' };
  const country = {
    countryName: 'COLOMBIA',
    gl: 'co',
    currencyName: 'Colombian Pesos',
    currencyCode: 'COP',
  };

  console.log(`Search test → ${marketplace.name} for "${product.name}"`);
  const start = Date.now();
  try {
    const r = await fetcher.fetchPrice({
      marketplace,
      product,
      brandName: 'Centrum',
      country,
    });
    console.log('\nRESULT:', JSON.stringify(r, null, 2));
    console.log(
      `\nHas COP price: ${r.precioConIva != null ? '✓ $' + r.precioConIva : '— not found'}`,
    );
  } catch (e) {
    console.error('threw:', e.message);
  } finally {
    console.log(`Done in ${Math.round((Date.now() - start) / 1000)}s`);
    process.exit(0);
  }
})();
