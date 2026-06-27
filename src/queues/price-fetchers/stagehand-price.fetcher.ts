import { Injectable, Logger } from '@nestjs/common';
import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import {
  MarketplacePriceFetcher,
  MarketplacePriceLookup,
  PriceFetchContext,
} from './price-fetcher.interface';

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
  productUrl: z.string().nullable().describe('Absolute URL of the product page'),
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

      await page.goto(marketplace.baseUrl, {
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

      // Use the marketplace's own (often JS-only) search. Non-fatal: if a step
      // fails we still try to extract from whatever page we ended up on.
      try {
        await stagehand.act(
          `Type "${product.name} ${brandName}" into the site's search box and press Enter to run the search.`,
        );
        // Async (e.g. Algolia/VTEX) result lists render after submit — nudge
        // Stagehand to wait until the products are actually on screen.
        await stagehand.act(
          'Wait until the product search results (with their prices) are visible on the page.',
        );
      } catch (actError: any) {
        this.logger.warn(
          `[${marketplace.name}] in-site search step failed for "${product.name}": ${actError.message}`,
        );
      }

      const extracted = await stagehand.extract(
        `From this page (search results or a product page), find the closest available match ` +
          `(exact or equivalent size/bundle) for "${product.name}" from brand "${brandName}" and report its price ` +
          `in ${country.currencyName} (${country.currencyCode}). The price MUST be in ${country.currencyCode}; if only ` +
          `another currency is shown, set inStock to false. If no matching product is visible, set inStock to false and prices to null.`,
        extractionSchema,
        {}, // force the (instruction, schema, options) overload so the result is typed to our schema
      );

      return {
        precioConIva: extracted.precioConIva ?? null,
        precioSinIva: extracted.precioSinIva ?? null,
        productUrl: extracted.productUrl ?? null,
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
