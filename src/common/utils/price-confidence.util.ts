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
