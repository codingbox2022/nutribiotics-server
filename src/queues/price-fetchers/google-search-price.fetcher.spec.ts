import { GoogleSearchPriceFetcher } from './google-search-price.fetcher';

/**
 * The JSON-extraction logic was lifted out of price-comparison.processor.ts.
 * These tests pin its behavior (markdown stripping, object extraction from
 * surrounding prose, graceful degradation to "not found").
 */
describe('GoogleSearchPriceFetcher.parseResponse', () => {
  const fetcher = new GoogleSearchPriceFetcher();
  // parseResponse is private; access via `any` to test the pure logic directly.
  const parse = (text?: string) =>
    (fetcher as any).parseResponse(text, 'Centrum Mujer', 'Test MP');

  it('exposes the browser/search-agnostic "search" strategy', () => {
    expect(fetcher.strategy).toBe('search');
  });

  it('parses a clean JSON object', () => {
    const r = parse(
      '{"precioConIva": 50000, "precioSinIva": null, "productUrl": "https://x.co/p/1", "productName": "Centrum", "inStock": true, "currency": "COP"}',
    );
    expect(r).toEqual({
      precioConIva: 50000,
      precioSinIva: null,
      productUrl: 'https://x.co/p/1',
      productName: 'Centrum',
      inStock: true,
      currency: 'COP',
    });
  });

  it('strips markdown code fences', () => {
    const r = parse('```json\n{"precioConIva": 12345, "inStock": true}\n```');
    expect(r.precioConIva).toBe(12345);
    expect(r.inStock).toBe(true);
    expect(r.productUrl).toBeNull();
  });

  it('extracts the JSON object from surrounding prose', () => {
    const r = parse('Here is the result: {"precioConIva": 999, "inStock": false} — done');
    expect(r.precioConIva).toBe(999);
    expect(r.inStock).toBe(false);
  });

  it('degrades to a not-found result for non-JSON text', () => {
    expect(parse('no relevant products found')).toEqual({
      precioSinIva: null,
      precioConIva: null,
      productUrl: null,
      productName: null,
      inStock: false,
      currency: null,
    });
  });

  it('degrades to a not-found result for empty/undefined input', () => {
    const empty = {
      precioSinIva: null,
      precioConIva: null,
      productUrl: null,
      productName: null,
      inStock: false,
      currency: null,
    };
    expect(parse('')).toEqual(empty);
    expect(parse(undefined)).toEqual(empty);
  });
});
