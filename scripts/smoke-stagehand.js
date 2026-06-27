/*
 * Manual smoke test for StagehandPriceFetcher (local Chromium).
 * Runs ONE real browser lookup against a non-indexed Colombian marketplace,
 * with no Mongo/Redis/Nest container — just the fetcher itself.
 *
 * Prereqs: `npm run build` first; .env with GOOGLE_GENERATIVE_AI_API_KEY;
 * Playwright Chromium installed (npx playwright install chromium).
 *
 * Usage: node scripts/smoke-stagehand.js
 */
require('dotenv').config();
const {
  StagehandPriceFetcher,
} = require('../dist/queues/price-fetchers/stagehand-price.fetcher');
const {
  classifyMarketplaceUrl,
  isCanonicalProductUrl,
  belongsToMarketplaceDomain,
  calculatePriceConfidence,
} = require('../dist/common/utils/price-confidence.util');

const EXPECTED_KEYS = [
  'currency',
  'inStock',
  'precioConIva',
  'precioSinIva',
  'productName',
  'productUrl',
];

// Force exit if a lookup hangs, so we never leave a browser running.
const hardTimeout = setTimeout(() => {
  console.error('✗ Hard timeout (180s) reached — forcing exit.');
  process.exit(1);
}, 180_000);

(async () => {
  const fetcher = new StagehandPriceFetcher();

  const marketplace = {
    name: process.env.SMOKE_MARKETPLACE || 'Farmatodo Colombia',
    baseUrl: process.env.SMOKE_URL || 'https://www.farmatodo.com.co',
    country: 'Colombia',
    ivaRate: 0.19,
    scanStrategy: 'browser',
    browserSetup: process.env.SMOKE_SETUP || undefined,
    searchUrlTemplate: process.env.SMOKE_SEARCH_URL || undefined,
  };
  const product = { name: process.env.SMOKE_PRODUCT || 'Centrum Mujer' };
  const brandName = process.env.SMOKE_BRAND || 'Centrum';
  const country = {
    countryName: 'COLOMBIA',
    gl: 'co',
    currencyName: 'Colombian Pesos',
    currencyCode: 'COP',
  };

  console.log(`Smoke test → ${marketplace.name} (${marketplace.baseUrl})`);
  console.log(`Product: "${product.name}"  (model: ${process.env.STAGEHAND_MODEL || 'google/gemini-2.5-flash'})`);
  const start = Date.now();

  try {
    const result = await fetcher.fetchPrice({
      marketplace,
      product,
      brandName,
      country,
    });

    const keys = Object.keys(result).sort();
    const shapeOk = JSON.stringify(keys) === JSON.stringify(EXPECTED_KEYS);

    console.log('\nRESULT:', JSON.stringify(result, null, 2));
    console.log(`\nShape matches MarketplacePriceLookup: ${shapeOk ? '✓' : '✗ got ' + keys.join(',')}`);
    console.log(`Has price: ${result.precioConIva != null ? '✓ ' + result.precioConIva : '— (not found / blocked — mechanism still OK)'}`);

    // Replicate the processor's confidence scoring to see if this result would
    // clear the 0.6 recommendation threshold.
    if (result.inStock && result.precioConIva != null) {
      const resolvedUrl = result.productUrl || marketplace.baseUrl;
      const urlType = classifyMarketplaceUrl(resolvedUrl);
      const isCanonical = isCanonicalProductUrl(urlType);
      const domainMatches = isCanonical
        ? belongsToMarketplaceDomain(resolvedUrl, marketplace.baseUrl)
        : false;
      const precioSinIvaCalculated = result.precioSinIva == null; // processor derives it from IVA
      let conf = calculatePriceConfidence({
        inStock: true,
        hasPrecioConIva: true,
        domainMatches,
        precioSinIvaCalculated,
      });
      if (!isCanonical) conf = Number(Math.max(0.05, conf * 0.85).toFixed(2));
      console.log(
        `Confidence: ${conf}  (urlType=${urlType}, domainMatch=${domainMatches}) → ${conf >= 0.6 ? '✓ feeds recommendations' : '✗ below 0.6 threshold'}`,
      );
    }
  } catch (e) {
    console.error('\n✗ fetchPrice threw (unexpected — should degrade to empty):', e.message);
  } finally {
    await fetcher.dispose();
    clearTimeout(hardTimeout);
    console.log(`\nDone in ${Math.round((Date.now() - start) / 1000)}s`);
    process.exit(0);
  }
})();
