export interface PriceConfidenceInput {
  inStock: boolean;
  hasPrecioConIva: boolean;
  domainMatches: boolean;
  precioSinIvaCalculated: boolean;
}

const DEFAULT_WEIGHTS = {
  inStock: 0.35,
  price: 0.3,
  domain: 0.25,
  ivaSource: 0.1,
};

function normalizeUrl(value: string | null | undefined): URL | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value);
  } catch (error) {
    try {
      return new URL(`https://${value}`);
    } catch (nestedError) {
      return null;
    }
  }
}

export function belongsToMarketplaceDomain(
  productUrl: string | null | undefined,
  marketplaceUrl: string | null | undefined,
): boolean {
  const product = normalizeUrl(productUrl);
  const marketplace = normalizeUrl(marketplaceUrl);

  if (!product || !marketplace) {
    return false;
  }

  const productHost = product.hostname.toLowerCase();
  const marketplaceHost = marketplace.hostname.toLowerCase();

  return (
    productHost === marketplaceHost ||
    productHost.endsWith(`.${marketplaceHost}`)
  );
}

export function calculatePriceConfidence(input: PriceConfidenceInput): number {
  let confidence = 0;

  if (input.inStock) {
    confidence += DEFAULT_WEIGHTS.inStock;
  }

  if (input.hasPrecioConIva) {
    confidence += DEFAULT_WEIGHTS.price;
  }

  if (input.domainMatches) {
    confidence += DEFAULT_WEIGHTS.domain;
  }

  confidence += input.precioSinIvaCalculated
    ? DEFAULT_WEIGHTS.ivaSource * 0.3
    : DEFAULT_WEIGHTS.ivaSource;

  return Number(Math.max(0, Math.min(1, confidence)).toFixed(2));
}

export type MarketplaceUrlType =
  | 'product_detail'
  | 'search'
  | 'category'
  | 'redirect'
  | 'unknown';

/**
 * Classify a URL by shape. Gates the price-confidence "domain match" signal:
 * only a canonical product page (on the marketplace's own domain) earns it.
 * After ruling out search / category / redirect, any non-trivial path is treated
 * as a product page — covers slug / code / `.html` product URLs (e.g. VTEX,
 * Cruz Verde) that don't use an explicit `/product` or `/p` segment.
 */
export function classifyMarketplaceUrl(
  url: string | null | undefined,
): MarketplaceUrlType {
  const parsed = normalizeUrl(url);
  if (!parsed) {
    return 'unknown';
  }

  const pathname = parsed.pathname.toLowerCase();
  const searchParams = parsed.searchParams;

  const redirectParamKeys = ['url', 'u', 'target', 'dest', 'destination', 'redirect', 'redir', 'r', 'out'];
  for (const key of redirectParamKeys) {
    const value = searchParams.get(key);
    if (value && /(https?:\/\/|www\.)/i.test(value)) {
      return 'redirect';
    }
  }

  if (
    pathname.includes('/redirect') ||
    pathname.startsWith('/out') ||
    pathname.includes('/goto') ||
    pathname.includes('/click') ||
    pathname.includes('/tracking') ||
    pathname.includes('/trk')
  ) {
    return 'redirect';
  }

  const searchParamKeys = ['q', '_q', 'query', 'search', 's', 'keyword', 'keywords', 'k', 'term'];
  for (const key of searchParamKeys) {
    if (searchParams.has(key)) {
      return 'search';
    }
  }
  // VTEX faceted search/category listings (e.g. ?map=ft, ?map=c) are never product pages.
  if (searchParams.has('map')) {
    return 'search';
  }

  if (
    pathname.includes('/search') ||
    pathname.includes('/buscar') ||
    pathname.includes('/results') ||
    pathname === '/s' ||
    pathname.startsWith('/s/')
  ) {
    return 'search';
  }

  if (
    pathname.includes('/category') ||
    pathname.includes('/categoria') ||
    pathname.includes('/collection') ||
    pathname.includes('/collections') ||
    pathname.includes('/department') ||
    pathname.includes('/departments') ||
    pathname.includes('/product-category') ||
    pathname.includes('/catalog') ||
    pathname.includes('/catalogo') ||
    pathname.includes('/tienda') ||
    pathname.includes('/productos') ||
    pathname.includes('/c/')
  ) {
    return 'category';
  }

  if (
    pathname.includes('/product') ||
    pathname.includes('/producto') ||
    pathname.includes('/p/') ||
    pathname.endsWith('/p') ||
    pathname.includes('/item') ||
    pathname.includes('/items') ||
    pathname.includes('/dp/') ||
    pathname.includes('/gp/product')
  ) {
    return 'product_detail';
  }

  // Fallback: a non-trivial path that isn't search/category/redirect is most
  // likely a product detail page (slug / code / .html style product URLs).
  if (pathname.length > 1) {
    return 'product_detail';
  }

  return 'unknown';
}

export function isCanonicalProductUrl(urlType: MarketplaceUrlType): boolean {
  return urlType === 'product_detail';
}
