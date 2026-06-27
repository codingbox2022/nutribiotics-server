import {
  classifyMarketplaceUrl,
  isCanonicalProductUrl,
  belongsToMarketplaceDomain,
  calculatePriceConfidence,
} from './price-confidence.util';

describe('classifyMarketplaceUrl', () => {
  it('treats real product pages (slug/code/.html, /p) as product_detail', () => {
    expect(
      classifyMarketplaceUrl(
        'https://www.cruzverde.com.co/centrum-women-tabletas-frasco-x30/COCV_158620.html',
      ),
    ).toBe('product_detail');
    expect(
      classifyMarketplaceUrl(
        'https://www.farmaciaspasteur.com.co/salud-vitaminas-centrum-women-139038/p',
      ),
    ).toBe('product_detail');
  });

  it('treats VTEX faceted search/category listings as search (not product)', () => {
    // VTEX full-text search: path is the query slug + ?_q=...&map=ft
    expect(
      classifyMarketplaceUrl(
        'https://www.drogueriascolsubsidio.com/centrum%20mujer?_q=Centrum%20Mujer&map=ft',
      ),
    ).toBe('search');
    expect(classifyMarketplaceUrl('https://site.com/anything?map=c')).toBe('search');
  });

  it('treats explicit search/category paths accordingly', () => {
    expect(
      classifyMarketplaceUrl('https://www.farmatodo.com.co/buscar?product=Centrum'),
    ).toBe('search');
    expect(classifyMarketplaceUrl('https://shop.com/search?q=vitamins')).toBe('search');
    expect(classifyMarketplaceUrl('https://shop.com/categoria/vitaminas')).toBe('category');
  });

  it('treats the homepage / root as unknown (not a product)', () => {
    expect(classifyMarketplaceUrl('https://www.cruzverde.com.co')).toBe('unknown');
    expect(classifyMarketplaceUrl('https://www.cruzverde.com.co/')).toBe('unknown');
  });

  it('isCanonicalProductUrl is true only for product_detail', () => {
    expect(isCanonicalProductUrl('product_detail')).toBe(true);
    expect(isCanonicalProductUrl('search')).toBe(false);
    expect(isCanonicalProductUrl('unknown')).toBe(false);
  });
});

describe('confidence end-to-end for a browser hit', () => {
  it('a real on-domain product URL clears the 0.6 recommendation threshold', () => {
    const url =
      'https://www.cruzverde.com.co/centrum-women-tabletas-frasco-x30/COCV_158620.html';
    const base = 'https://www.cruzverde.com.co';
    const isCanonical = isCanonicalProductUrl(classifyMarketplaceUrl(url));
    const domainMatches = isCanonical && belongsToMarketplaceDomain(url, base);
    const conf = calculatePriceConfidence({
      inStock: true,
      hasPrecioConIva: true,
      domainMatches,
      precioSinIvaCalculated: true,
    });
    expect(isCanonical).toBe(true);
    expect(domainMatches).toBe(true);
    expect(conf).toBeGreaterThanOrEqual(0.6);
  });

  it('falling back to the base URL stays below the threshold (honest null case)', () => {
    const base = 'https://www.farmatodo.com.co';
    const isCanonical = isCanonicalProductUrl(classifyMarketplaceUrl(base)); // homepage -> unknown
    let conf = calculatePriceConfidence({
      inStock: true,
      hasPrecioConIva: true,
      domainMatches: false,
      precioSinIvaCalculated: true,
    });
    if (!isCanonical) conf = Number(Math.max(0.05, conf * 0.85).toFixed(2));
    expect(conf).toBeLessThan(0.6);
  });

  it('a browser listing-only price (domain-verified, no product page) clears the threshold at ~0.79', () => {
    // Browser strategy credits domainMatches by construction; the non-canonical
    // penalty still applies because we only have the listing, not a product page.
    let conf = calculatePriceConfidence({
      inStock: true,
      hasPrecioConIva: true,
      domainMatches: true,
      precioSinIvaCalculated: true,
    });
    conf = Number(Math.max(0.05, conf * 0.85).toFixed(2));
    expect(conf).toBeGreaterThanOrEqual(0.6);
    expect(conf).toBeLessThan(0.93);
  });
});
