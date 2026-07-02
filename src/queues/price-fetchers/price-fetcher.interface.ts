import { MarketplaceDocument } from '../../marketplaces/schemas/marketplace.schema';
import { ProductDocument } from '../../products/schemas/product.schema';

/**
 * How a marketplace's prices are acquired.
 * - `search`: products are Google-indexed; use cheap LLM web search.
 * - `browser`: products are not reliably indexed; drive a real browser.
 */
export type ScanStrategy = 'search' | 'browser';

/** Country/currency context for a single marketplace lookup. */
export interface SearchCountryConfig {
  countryName: string;
  gl: string;
  currencyName: string;
  currencyCode: string;
}

/**
 * Structured result of a price lookup. This is the contract every acquisition
 * method must satisfy (formerly the inline `searchSchema` in the processor).
 * The price-comparison processor consumes exactly these fields.
 */
export interface MarketplacePriceLookup {
  precioSinIva: number | null;
  precioConIva: number | null;
  productUrl: string | null;
  productName: string | null;
  inStock: boolean;
  currency: string | null;
  /**
   * How the price was matched:
   * - `exact`: the exact product name + brand.
   * - `equivalent`: a cross-brand product with the same active ingredient(s) and
   *   dose, found by the brand-free fallback pass when the exact match failed.
   * Absent = treated as `exact`. The processor lowers priceConfidence for
   * `equivalent` matches since they are a looser, cross-brand comparison.
   */
  matchType?: 'exact' | 'equivalent';
}

export interface PriceFetchContext {
  marketplace: MarketplaceDocument;
  product: ProductDocument;
  brandName: string;
  country: SearchCountryConfig;
  /**
   * Brand-free ingredient + dose search term (e.g. "Coenzima Q10 200mg"), built
   * by the processor from the product's ingredients. When the exact name+brand
   * pass finds nothing, fetchers retry with this to catch equivalent products
   * sold under a different brand. Null/absent → no fallback pass.
   */
  equivalentQuery?: string | null;
}

/**
 * A pluggable strategy for fetching a competitor price from one marketplace.
 * Implementations must NOT throw for "searched but nothing found" — return an
 * empty lookup (inStock:false, null prices) instead, mirroring the legacy
 * not-found handling. Hard/unexpected failures may throw.
 */
export interface MarketplacePriceFetcher {
  readonly strategy: ScanStrategy;
  fetchPrice(ctx: PriceFetchContext): Promise<MarketplacePriceLookup>;
}
