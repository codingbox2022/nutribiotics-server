import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Stagehand } from '@browserbasehq/stagehand';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import {
  MarketplacePriceFetcher,
  MarketplacePriceLookup,
  PriceFetchContext,
} from './price-fetcher.interface';
import {
  classifyMarketplaceUrl,
  isCanonicalProductUrl,
  belongsToMarketplaceDomain,
} from '../../common/utils/price-confidence.util';

// Default extraction model for Stagehand's act/extract reasoning. Overridable so
// it can be tuned at smoke-test time without a code change.
const STAGEHAND_MODEL = process.env.STAGEHAND_MODEL || 'google/gemini-2.5-flash';
const NAV_TIMEOUT_MS = Number(process.env.BROWSER_NAV_TIMEOUT_MS) || 45_000;

// After a launch failure, don't retry a fresh 25s launch on every one of the
// hundreds of lookups in a run — wait out this cooldown, then allow a relaunch
// in a later run. Recovery without a same-run retry storm.
const RELAUNCH_COOLDOWN_MS =
  Number(process.env.BROWSER_RELAUNCH_COOLDOWN_MS) || 60_000;
// Bounded-lifetime recycle to cap memory growth of a never-disposed browser.
// 0 = disabled (default). Keep disabled until the container runs with --init,
// since a recycle triggers a relaunch that needs a PID-1 reaper to be reliable.
const RECYCLE_EVERY_RUNS = Number(process.env.BROWSER_RECYCLE_EVERY_RUNS) || 0;

// chrome-launcher (used by Stagehand env:'LOCAL') finds the browser via
// executablePath / CHROME_PATH / `which` — it ignores PLAYWRIGHT_BROWSERS_PATH.
// Prefer CHROME_PATH, but defensively ignore an unset, unexpanded ("${...}", e.g.
// a mis-entered Dokploy env value), or non-existent path and fall back to the
// common system locations. Returns undefined so chrome-launcher auto-discovers
// (correct on local macOS, where no CHROME_PATH is set).
const CHROME_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];
function resolveChromePath(): string | undefined {
  const env = process.env.CHROME_PATH;
  if (env && !env.includes('${') && existsSync(env)) return env;
  return CHROME_CANDIDATES.find((c) => existsSync(c));
}

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
 * The browser is PERSISTENT for the whole app lifetime: launched once (at boot
 * warm-up or first use), reused across ALL runs, and closed only on app shutdown.
 * We never tear it down per-run because Chromium is spawned via chrome-launcher
 * and Node is PID 1 in the container — without a reaper, a *second* launch dies
 * (OOM) before binding its debug port (ECONNREFUSED). Launching exactly once
 * sidesteps that entirely. A relaunch happens in only one place: when the browser
 * is detected dead (see getStagehand). Browser lookups are serialized by
 * BROWSER_SCAN_CONCURRENCY (default 1); raising it needs a page per concurrent
 * lookup (the shared active page is context-global).
 */
@Injectable()
export class StagehandPriceFetcher
  implements MarketplacePriceFetcher, OnApplicationShutdown
{
  readonly strategy = 'browser' as const;
  private readonly logger = new Logger(StagehandPriceFetcher.name);

  private stagehand: Stagehand | null = null;
  private initPromise: Promise<Stagehand> | null = null;
  // Run the (synchronous, ~40s worst-case) Chromium diagnostic at most once per
  // run when a lookup's init fails, so we capture the real crash cause without
  // spamming it across all 486 lookups. Re-armed in cleanupAfterRun().
  private diagnosedThisRun = false;
  private lastLaunchFailAt = 0; // epoch ms of the last failed launch (cooldown)
  private runsSinceLaunch = 0; // for the bounded-lifetime recycle

  async fetchPrice(ctx: PriceFetchContext): Promise<MarketplacePriceLookup> {
    const { marketplace, product, brandName, country, equivalentQuery } = ctx;

    let stagehand: Stagehand;
    try {
      stagehand = await this.getStagehand();
    } catch (initError: any) {
      this.logger.error(
        `Stagehand init failed; skipping browser lookup for "${product.name}" on ${marketplace.name}: ${initError.message}`,
      );
      // First failure of the run: spawn Chromium directly to capture the REAL
      // cause (exit signal SIGKILL = OOM-killed; a shared-lib error = missing dep;
      // sandbox/namespace text = seccomp/perms) instead of the opaque ECONNREFUSED.
      if (!this.diagnosedThisRun) {
        this.diagnosedThisRun = true;
        this.logger.error(
          `🔎 Chromium launch diagnostic (scan-time):\n${this.diagnoseBrowserLaunch()}`,
        );
      }
      return { ...EMPTY_RESULT };
    }

    // Pass 1: exact product + brand. Build the search query first (avoid a
    // redundant brand when the product name already contains it, e.g.
    // "Centrum Mujer" + "Centrum").
    const strictQuery =
      brandName && !product.name.toLowerCase().includes(brandName.toLowerCase())
        ? `${product.name} ${brandName}`
        : product.name;
    const strict = await this.searchAndExtract(
      stagehand,
      marketplace,
      country,
      strictQuery,
      `the closest available match (exact or equivalent size/bundle) for "${product.name}" from brand "${brandName}"`,
      product.name,
    );
    if (strict.inStock || !equivalentQuery) {
      return { ...strict, matchType: 'exact' };
    }

    // Pass 2: exact match failed — retry brand-free by ingredient + dose to catch
    // an equivalent product sold under a different brand (lower-confidence match).
    this.logger.log(
      `[${marketplace.name}] no exact match for "${product.name}"; trying equivalent query "${equivalentQuery}"`,
    );
    const equivalent = await this.searchAndExtract(
      stagehand,
      marketplace,
      country,
      equivalentQuery,
      `any dietary supplement — regardless of brand — whose main active ingredient(s) and dose match "${equivalentQuery}" (a DIFFERENT brand is expected and acceptable)`,
      product.name,
    );
    return equivalent.inStock
      ? { ...equivalent, matchType: 'equivalent' }
      : { ...strict, matchType: 'exact' };
  }

  /**
   * One browser pass: navigate to the marketplace, run `searchQuery` through the
   * site's own search, and extract the price of the result described by
   * `matchDescriptor`. Any browse/extract failure degrades to EMPTY_RESULT so the
   * run stays resilient (mirrors the search fetcher). Called once for the exact
   * pass and, on a miss, again for the brand-free equivalent pass.
   */
  private async searchAndExtract(
    stagehand: Stagehand,
    marketplace: PriceFetchContext['marketplace'],
    country: PriceFetchContext['country'],
    searchQuery: string,
    matchDescriptor: string,
    productName: string,
  ): Promise<MarketplacePriceLookup> {
    try {
      const page =
        stagehand.context.activePage() ?? (await stagehand.context.newPage());
      stagehand.context.setActivePage(page);

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
          `[${marketplace.name}] in-site search step failed for "${productName}": ${actError.message}`,
        );
      }

      this.logger.log(
        `[${marketplace.name}] results URL: ${stagehand.context.activePage()?.url()}`,
      );

      // Read the price from the results page first — this is the reliable extraction.
      const extracted = await stagehand.extract(
        `From the search results, find ${matchDescriptor} and report its price in ${country.currencyName} ` +
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
            `Click the product title or image of the search result that best matches ${matchDescriptor} ` +
              `to navigate to its product detail page.`,
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
            isCanonicalProductUrl(classifyMarketplaceUrl(urlAfter)) &&
            belongsToMarketplaceDomain(urlAfter, marketplace.baseUrl)
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
        `[${marketplace.name}] browser lookup failed for "${productName}": ${error.message}`,
      );
      return { ...EMPTY_RESULT };
    }
  }

  /**
   * Return the persistent browser, launching it once and reusing it forever.
   * The ONLY relaunch site: if a cached browser is detected dead, it is torn
   * down and relaunched (cooldown-guarded so a failing launch doesn't retry on
   * every lookup in a run).
   */
  private async getStagehand(): Promise<Stagehand> {
    if (this.stagehand) {
      if (await this.isBrowserAlive(this.stagehand)) {
        return this.stagehand;
      }
      this.logger.warn('Persistent browser unresponsive; recycling.');
      await this.teardown({ force: true });
    }
    if (!this.initPromise) {
      const since = Date.now() - this.lastLaunchFailAt;
      if (this.lastLaunchFailAt && since < RELAUNCH_COOLDOWN_MS) {
        throw new Error(
          `browser launch on cooldown (${Math.round(
            (RELAUNCH_COOLDOWN_MS - since) / 1000,
          )}s left) after a recent failure`,
        );
      }
      this.initPromise = this.createStagehand();
    }
    try {
      return await this.initPromise;
    } catch (err) {
      // Clear the rejected promise and stamp the cooldown so a later run can
      // relaunch, but the rest of THIS run fails fast instead of relaunching.
      this.initPromise = null;
      this.lastLaunchFailAt = Date.now();
      throw err;
    }
  }

  /**
   * Best-effort liveness probe for the persistent browser. A crashed/OOM-killed
   * Chrome closes its CDP socket, so a cheap Browser-domain round-trip rejects.
   * Feature-detected (Stagehand 3.6.x exposes page.sendCDP); if unavailable we
   * assume alive rather than force a needless relaunch.
   */
  private async isBrowserAlive(sh: Stagehand): Promise<boolean> {
    try {
      const ctx: any = (sh as any).context;
      const page = ctx?.activePage?.() ?? ctx?.pages?.()?.[0];
      if (!page) return false;
      if (typeof page.sendCDP === 'function') {
        await this.withTimeout(page.sendCDP('Browser.getVersion'), 3_000);
      }
      return true;
    } catch {
      return false;
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
      ),
    ]);
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
      // Stagehand env:'LOCAL' spawns Chromium via chrome-launcher (a real Chrome
      // process on a random --remote-debugging-port, driven over CDP) — NOT
      // Playwright. Two container consequences handled here:
      //  1) --no-sandbox is load-bearing: as the non-root `node` user on the slim
      //     image, Chrome's setuid sandbox fails and the process dies on startup;
      //     the debug port never opens and the CDP connect throws ECONNREFUSED.
      //  2) chrome-launcher IGNORES PLAYWRIGHT_BROWSERS_PATH; it finds the binary
      //     via executablePath / CHROME_PATH / `which`. Pin CHROME_PATH in the
      //     container (see Dockerfile) so the exact chromium is launched instead
      //     of relying on nondeterministic discovery. Unset locally → auto-detect.
      localBrowserLaunchOptions: {
        headless: true,
        executablePath: resolveChromePath(),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      },
    });
    // Surface the real Chromium failure. Callers only log initError.message,
    // which reduces a launch crash to an opaque "ECONNREFUSED"; the stack here
    // carries the actionable cause (missing lib, sandbox, etc.).
    try {
      await stagehand.init();
    } catch (initError: any) {
      this.logger.error(
        `Stagehand LOCAL init failed (model: ${STAGEHAND_MODEL}): ${initError?.stack ?? initError?.message ?? initError}`,
      );
      throw initError;
    }
    this.stagehand = stagehand;
    this.logger.log(`Local browser started (model: ${STAGEHAND_MODEL})`);
    return stagehand;
  }

  /**
   * Diagnostic: spawn the Chromium binary directly and capture its stderr, so a
   * launch crash reports the REAL cause (missing shared library, sandbox, seccomp,
   * bad binary...) instead of the opaque CDP "ECONNREFUSED". Synchronous and
   * best-effort; intended to run once after a failed init. Returns a log-ready
   * multi-line string.
   */
  diagnoseBrowserLaunch(): string {
    const lines: string[] = [];
    lines.push(`CHROME_PATH env = ${JSON.stringify(process.env.CHROME_PATH)}`);
    const binPath = resolveChromePath();
    lines.push(`resolved binary = ${binPath ?? '(none found on disk)'}`);
    if (!binPath) {
      lines.push(
        `No Chromium found at any of: ${CHROME_CANDIDATES.join(', ')}. Install one or fix CHROME_PATH.`,
      );
      return lines.join('\n');
    }
    const probes: string[][] = [
      ['--version'],
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--dump-dom',
        'about:blank',
      ],
    ];
    for (const args of probes) {
      try {
        const r = spawnSync(binPath, args, { timeout: 20_000, encoding: 'utf8' });
        lines.push(`--- ${binPath} ${args[0]} → status=${r.status} signal=${r.signal ?? ''}${r.error ? ' spawnError=' + r.error.message : ''}`);
        const err = (r.stderr || '').trim();
        const out = (r.stdout || '').trim();
        if (err) lines.push(`  stderr: ${err.slice(0, 1500)}`);
        else if (out) lines.push(`  stdout: ${out.slice(0, 300)}`);
      } catch (e: any) {
        lines.push(`--- ${binPath} ${args[0]} → threw: ${e?.message ?? e}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Boot-time warm-up: launch the persistent browser and KEEP it, so a Chromium
   * launch failure surfaces loudly at startup (real stack) and the launched
   * browser is the exact instance every scan reuses — no per-run relaunch.
   * Rethrows the real init error on failure.
   */
  async warmUp(): Promise<void> {
    await this.getStagehand();
  }

  /**
   * End-of-run hook: KEEP the browser alive, only free per-run state. Closes
   * extra tabs and resets the surviving page to about:blank so the next run
   * starts clean without paying for a relaunch. Best-effort: any page-API issue
   * just no-ops and leaves the browser up.
   */
  async cleanupAfterRun(): Promise<void> {
    this.diagnosedThisRun = false;
    const stagehand = this.stagehand;
    if (!stagehand) return;
    if (!(await this.isBrowserAlive(stagehand))) {
      // Dead → leave fields; the next getStagehand() recycles + relaunches.
      return;
    }
    if (RECYCLE_EVERY_RUNS > 0 && ++this.runsSinceLaunch >= RECYCLE_EVERY_RUNS) {
      this.logger.log(`Recycling browser after ${this.runsSinceLaunch} runs`);
      await this.teardown({ force: false });
      return;
    }
    try {
      const ctx: any = (stagehand as any).context;
      const pages: any[] = typeof ctx?.pages === 'function' ? ctx.pages() : [];
      for (const p of pages.slice(1)) {
        try {
          await p.close();
        } catch {
          /* best-effort */
        }
      }
      const keep = ctx?.activePage?.() ?? ctx?.pages?.()?.[0] ?? null;
      if (keep) {
        try {
          await keep.goto('about:blank', {
            waitUntil: 'domcontentloaded',
            timeoutMs: 10_000,
          });
        } catch {
          /* best-effort */
        }
        ctx?.setActivePage?.(keep);
      }
    } catch (e: any) {
      this.logger.warn(`Per-run page cleanup failed (browser kept): ${e.message}`);
    }
  }

  /** Close the browser on app shutdown (SIGTERM/SIGINT). Requires enableShutdownHooks(). */
  async onApplicationShutdown(): Promise<void> {
    await this.teardown();
  }

  /** Back-compat alias (used by scripts/smoke-stagehand.js). */
  async dispose(): Promise<void> {
    await this.teardown();
  }

  /**
   * Fully close and release the browser. Captures the reference, AWAITS close()
   * (bounded), THEN nulls the fields — order matters: nulling first (the old bug)
   * let a concurrent lookup launch a second browser while this one was still
   * closing. `force` closes a hung/dead browser without waiting on a clean close.
   */
  private async teardown(opts: { force?: boolean } = {}): Promise<void> {
    const stagehand = this.stagehand;
    if (stagehand) {
      try {
        await this.withTimeout(
          (stagehand as any).close(opts.force ? { force: true } : undefined),
          15_000,
        );
        this.logger.log('Local browser closed');
      } catch (closeError: any) {
        this.logger.warn(`Stagehand close failed: ${closeError.message}`);
      }
    }
    this.stagehand = null;
    this.initPromise = null;
    this.runsSinceLaunch = 0;
  }
}
