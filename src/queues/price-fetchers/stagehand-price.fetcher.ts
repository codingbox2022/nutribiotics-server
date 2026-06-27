import { Injectable, Logger } from '@nestjs/common';
import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import {
  MarketplacePriceFetcher,
  MarketplacePriceLookup,
  PriceFetchContext,
} from './price-fetcher.interface';
import {
  classifyMarketplaceUrl,
  isCanonicalProductUrl,
} from '../../common/utils/price-confidence.util';

// Default extraction model for Stagehand's act/extract reasoning. Overridable so
// it can be tuned at smoke-test time without a code change.
const STAGEHAND_MODEL = process.env.STAGEHAND_MODEL || 'google/gemini-2.5-flash';
const NAV_TIMEOUT_MS = Number(process.env.BROWSER_NAV_TIMEOUT_MS) || 45_000;

// Zod schema Stagehand uses to structure the page extraction. Mirrors
// MarketplacePriceLookup so the processor consumes it unchanged.
const extractionSchema = z.object({
  precioConIva: z
    .number()
    .nullable()
    .describe('Displayed price INCLUDING tax/IVA, as a number, no currency symbol'),
  precioSinIva: z
    .number()
    .nullable()
    .describe('Price excluding tax/IVA if separately shown, else null'),
  productName: z.string().nullable().describe('The exact product name found'),
  inStock: z.boolean().describe('Whether a matching product is available'),
  currency: z.string().nullable().describe('Currency code of the price, e.g. COP'),
});

const EMPTY_RESULT: MarketplacePriceLookup = {
  precioSinIva: null,
  precioConIva: null,
  productUrl: null,
  productName: null,
  inStock: false,
  currency: null,
};

/**
 * Acquisition strategy for non-indexed marketplaces: drives a real headless
 * Chromium (Stagehand, env=LOCAL) to use the site's own search and read the
 * rendered product page — reaching sites Google search can't.
 *
 * One browser instance is lazily created and REUSED across all browser lookups
 * in a run (cheap because browser lookups are serialized by BROWSER_SCAN_CONCURRENCY,
 * default 1), then released via dispose() at the end of the run. Raising that
 * concurrency would require a page/context per concurrent lookup.
 */
@Injectable()
export class StagehandPriceFetcher implements MarketplacePriceFetcher {
  readonly strategy = 'browser' as const;
  private readonly logger = new Logger(StagehandPriceFetcher.name);

  private stagehand: Stagehand | null = null;
  private initPromise: Promise<Stagehand> | null = null;

  async fetchPrice(ctx: PriceFetchContext): Promise<MarketplacePriceLookup> {
    const { marketplace, product, brandName, country } = ctx;

    let stagehand: Stagehand;
    try {
      stagehand = await this.getStagehand();
    } catch (initError: any) {
      this.logger.error(
        `Stagehand init failed; skipping browser lookup for "${product.name}" on ${marketplace.name}: ${initError.message}`,
      );
      return { ...EMPTY_RESULT };
    }

    try {
      const page =
        stagehand.context.activePage() ?? (await stagehand.context.newPage());
      stagehand.context.setActivePage(page);

      // Build the search query first (avoid a redundant brand when the product
      // name already contains it, e.g. "Centrum Mujer" + "Centrum").
      const searchQuery =
        brandName && !product.name.toLowerCase().includes(brandName.toLowerCase())
          ? `${product.name} ${brandName}`
          : product.name;

      // Per-site optimization: if the marketplace defines a search-URL template,
      // navigate straight to its results page (deterministic, far more reliable
      // than driving the JS search box). Otherwise start from the homepage and
      // drive the on-page search (the generic path for discovery-found sites).
      const usingTemplate = Boolean(marketplace.searchUrlTemplate);
      const searchUrl = usingTemplate
        ? marketplace.searchUrlTemplate!.replace(
            /\{query\}/g,
            encodeURIComponent(searchQuery),
          )
        : marketplace.baseUrl;

      await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeoutMs: NAV_TIMEOUT_MS,
      });

      // Some marketplaces (e.g. Farmatodo) hide prices until you accept cookies
      // or pick a city/store. Prime the page first — non-fatal, and overridable
      // per-site via marketplace.browserSetup.
      const setupInstruction =
        marketplace.browserSetup ||
        `If a cookie or consent banner is shown, accept it. If the page requires choosing a city, region, or store before it will show prices, select a major city in ${country.countryName} (for Colombia, choose Bogotá). If none of these are present, do nothing.`;
      try {
        await stagehand.act(setupInstruction);
      } catch (setupError: any) {
        this.logger.warn(
          `[${marketplace.name}] page-priming step skipped: ${setupError.message}`,
        );
      }

      // Run the on-page search only when we didn't jump straight to a results URL,
      // then wait for the result list to render.
      try {
        if (!usingTemplate) {
          await stagehand.act(
            `Type "${searchQuery}" into the site's search box and press Enter to run the search.`,
          );
        }
        await stagehand.act(
          'Wait until the product search results (with their prices) are visible on the page.',
        );
      } catch (actError: any) {
        this.logger.warn(
          `[${marketplace.name}] in-site search step failed for "${product.name}": ${actError.message}`,
        );
      }

      this.logger.log(
        `[${marketplace.name}] results URL: ${stagehand.context.activePage()?.url()}`,
      );

      // Read the price from the results page first — this is the reliable extraction.
      const extracted = await stagehand.extract(
        `From the search results, find the closest available match (exact or equivalent size/bundle) for ` +
          `"${product.name}" from brand "${brandName}" and report its price in ${country.currencyName} ` +
          `(${country.currencyCode}). The price MUST be in ${country.currencyCode}; if only another currency ` +
          `is shown, set inStock to false. If no matching product is shown, set inStock to false and prices to null.`,
        extractionSchema,
        {}, // force the (instruction, schema, options) overload so the result is typed to our schema
      );

      // Best-effort: open the matched product to capture a real, on-domain product
      // URL (page.url()) for the confidence model. This NEVER affects the price we
      // already read above — a failed open just leaves productUrl null.
      let productUrl: string | null = null;
      if (extracted.inStock) {
        try {
          const urlBefore = stagehand.context.activePage()?.url() ?? null;
          await stagehand.act(
            `Click the product title or image of the search result that best matches "${product.name}" ` +
              `from brand "${brandName}" to navigate to its product detail page.`,
          );
          // Let SPA (VTEX/Angular) route changes settle so page.url() reflects the
          // product page rather than the search results we clicked from.
          try {
            await stagehand.act('Wait for the product detail page to finish loading.');
          } catch {
            // best-effort settle
          }
          const urlAfter = stagehand.context.activePage()?.url() ?? null;
          const base = marketplace.baseUrl.replace(/\/+$/, '');
          // Keep the URL only if the click actually NAVIGATED to a product page:
          // the URL changed, it isn't the homepage, and it's shaped like a product
          // page (not a search/category listing). Otherwise leave it null — an
          // honest null beats passing a search URL off as the product's URL.
          if (
            urlAfter &&
            urlAfter !== urlBefore &&
            urlAfter.replace(/\/+$/, '') !== base &&
            isCanonicalProductUrl(classifyMarketplaceUrl(urlAfter))
          ) {
            productUrl = urlAfter;
          }
        } catch (urlError: any) {
          this.logger.warn(
            `[${marketplace.name}] could not open product page for URL: ${urlError.message}`,
          );
        }
      }

      return {
        precioConIva: extracted.precioConIva ?? null,
        precioSinIva: extracted.precioSinIva ?? null,
        productUrl,
        productName: extracted.productName ?? null,
        inStock: extracted.inStock ?? false,
        currency: extracted.currency ?? null,
      };
    } catch (error: any) {
      // Treat any browse/extract failure (anti-bot, timeout, no results) as
      // "not found" so the run stays resilient, mirroring the search fetcher.
      this.logger.warn(
        `[${marketplace.name}] browser lookup failed for "${product.name}": ${error.message}`,
      );
      return { ...EMPTY_RESULT };
    }
  }

  /** Lazily create and reuse a single local browser instance. */
  private async getStagehand(): Promise<Stagehand> {
    if (this.stagehand) {
      return this.stagehand;
    }
    if (!this.initPromise) {
      this.initPromise = this.createStagehand();
    }
    return this.initPromise;
  }

  private async createStagehand(): Promise<Stagehand> {
    // Stagehand's reasoning model reads the Google key from env; make sure both
    // common var names are populated from whichever the app provides.
    const key =
      process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY;
    if (key) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||= key;
      process.env.GOOGLE_API_KEY ||= key;
    }

    const stagehand = new Stagehand({
      env: 'LOCAL',
      verbose: (Number(process.env.STAGEHAND_VERBOSE) || 0) as 0 | 1 | 2,
      model: STAGEHAND_MODEL,
      // Give JS-rendered result lists time to settle before act/extract read the DOM.
      domSettleTimeout: Number(process.env.BROWSER_DOM_SETTLE_MS) || 8000,
      localBrowserLaunchOptions: { headless: true },
    });
    await stagehand.init();
    this.stagehand = stagehand;
    this.logger.log(`Local browser started (model: ${STAGEHAND_MODEL})`);
    return stagehand;
  }

  /** Release the browser at the end of a run. No-op if never started. */
  async dispose(): Promise<void> {
    const stagehand = this.stagehand;
    this.stagehand = null;
    this.initPromise = null;
    if (stagehand) {
      try {
        await stagehand.close();
        this.logger.log('Local browser closed');
      } catch (closeError: any) {
        this.logger.warn(`Stagehand close failed: ${closeError.message}`);
      }
    }
  }
}
