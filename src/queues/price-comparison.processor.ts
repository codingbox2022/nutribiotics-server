import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { IngestionRunsService } from '../ingestion-runs/ingestion-runs.service';
import { PricesService } from '../prices/prices.service';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  Marketplace,
  MarketplaceDocument,
} from '../marketplaces/schemas/marketplace.schema';
import { Brand, BrandDocument } from '../brands/schemas/brand.schema';
import { RecommendationService, CompetitorPriceData } from './recommendation.service';
import { Price, PriceDocument } from '../prices/schemas/price.schema';
import { RecommendationsService } from '../recommendations/recommendations.service';
import {
  belongsToMarketplaceDomain,
  calculatePriceConfidence,
  classifyMarketplaceUrl,
  isCanonicalProductUrl,
  MarketplaceUrlType,
} from '../common/utils/price-confidence.util';
import { GoogleSearchPriceFetcher } from './price-fetchers/google-search-price.fetcher';
import { StagehandPriceFetcher } from './price-fetchers/stagehand-price.fetcher';
import {
  MarketplacePriceFetcher,
  MarketplacePriceLookup,
  SearchCountryConfig,
} from './price-fetchers/price-fetcher.interface';

export interface PriceComparisonJobData {
  triggeredBy?: string;
  timestamp: Date;
  ingestionRunId?: string;
  productId?: string;
}

const MIN_RECOMMENDATION_PRICE_CONFIDENCE = 0.6;
const MARKETPLACE_SEARCH_TIMEOUT_MS = 5 * 60 * 1000;
const GENERIC_KEEP_REASON = 'No se encontró información suficiente de competidores; se recomienda mantener el precio actual.';

// Country and currency configuration
const COUNTRY_SEARCH_CONFIG: Record<string, SearchCountryConfig> = {
  COLOMBIA: {
    countryName: 'COLOMBIA',
    gl: 'co',
    currencyName: 'Colombian Pesos',
    currencyCode: 'COP',
  },
  // Future countries can be added here
};

const DEFAULT_COUNTRY = 'COLOMBIA';

@Processor('price-comparison')
export class PriceComparisonProcessor extends WorkerHost {
  private readonly logger = new Logger(PriceComparisonProcessor.name);

  constructor(
    private readonly ingestionRunsService: IngestionRunsService,
    private readonly pricesService: PricesService,
    private readonly recommendationService: RecommendationService,
    private readonly recommendationsService: RecommendationsService,
    private readonly googleSearchFetcher: GoogleSearchPriceFetcher,
    private readonly stagehandFetcher: StagehandPriceFetcher,
    @InjectModel(Product.name)
    private productModel: Model<ProductDocument>,
    @InjectModel(Marketplace.name)
    private marketplaceModel: Model<MarketplaceDocument>,
    @InjectModel(Brand.name)
    private brandModel: Model<BrandDocument>,
    @InjectModel(Price.name)
    private priceModel: Model<PriceDocument>,
  ) {
    super();
  }

  async process(job: Job<PriceComparisonJobData>): Promise<void> {
    this.logger.log(`Starting price comparison job ${job.id}`);
    const { triggeredBy, timestamp, ingestionRunId, productId } = job.data;

    let runId: Types.ObjectId | string | undefined;

    try {
      // Step 1: Fetch real products and marketplaces from database
      this.logger.log(`Step 1: Fetching products from database${productId ? ' (intelligent price search mode)' : ''}...`);
      const nutribioticsBrand = await this.brandModel
        .findOne({ name: { $regex: /^nutrabiotics$/i } })
        .exec();

      let productQuery: any = { status: 'active' };

      // If productId is provided, search for all competitor products comparable to it
      // Note: productId will always be a Nutribiotics product from the UI
      if (productId) {
        const targetProduct = await this.productModel
          .findById(productId)
          .exec();

        if (!targetProduct) {
          throw new Error(`Product with ID ${productId} not found`);
        }

        this.logger.log(`[DEBUG] Target product found: name="${targetProduct.name}", status="${targetProduct.status}", brand="${targetProduct.brand}"`);

        // Search for all competitor products that compare to this Nutribiotics product
        this.logger.log(`Finding all competitor products comparable to Nutribiotics product ${productId}...`);

        // DEBUG: First query WITHOUT status filter to see all linked competitors
        const allLinkedProducts = await this.productModel
          .find({ comparedTo: new Types.ObjectId(productId) })
          .populate({ path: 'brand', select: 'name status' })
          .exec();

        this.logger.log(`[DEBUG] Total products linked via comparedTo (any status): ${allLinkedProducts.length}`);
        for (const lp of allLinkedProducts) {
          const lpBrand = (lp.brand as any)?.name || 'Unknown';
          this.logger.log(`[DEBUG]   - "${lp.name}" | brand="${lpBrand}" | status="${lp.status}" | id=${lp._id}`);
        }

        productQuery = {
          status: 'active',
          comparedTo: new Types.ObjectId(productId),
        };

        // Exclude Nutribiotics brand if it exists
        if (nutribioticsBrand) {
          productQuery.brand = { $ne: nutribioticsBrand._id };
          this.logger.log(`[DEBUG] Excluding Nutribiotics brand ID: ${nutribioticsBrand._id}`);
        }

        this.logger.log(`[DEBUG] Final product query: ${JSON.stringify(productQuery)}`);
      } else {
        // Default: search all competitor products (excluding Nutribiotics)
        if (nutribioticsBrand) {
          productQuery.brand = { $ne: nutribioticsBrand._id };
        }
      }

      const [products, marketplaces] = await Promise.all([
        this.productModel
          .find(productQuery)
          .populate({ path: 'brand', select: 'name status' })
          .exec(),
        this.marketplaceModel
          .find({
            status: 'active',
          })
          .exec(),
      ]);

      const totalProducts = products.length;
      const totalMarketplaces = marketplaces.length;
      const totalLookups = totalProducts * totalMarketplaces;

      this.logger.log(
        `Found ${totalProducts} products and ${totalMarketplaces} marketplaces (${totalLookups} total lookups)`,
      );

      // Create or use existing ingestion run (create BEFORE validation so it appears in list)
      if (ingestionRunId) {
        runId = ingestionRunId;
        await this.ingestionRunsService.markAsRunning(runId);
      } else {
        const run = await this.ingestionRunsService.create(
          triggeredBy || 'system',
          totalProducts,
          totalLookups,
          productId,
        );
        runId = run._id;
        await this.ingestionRunsService.markAsRunning(runId);
      }

      // Log the products that matched the query
      if (productId) {
        this.logger.log(`[DEBUG] Products matching final query (status=active, comparedTo=${productId}): ${products.length}`);
        for (const p of products) {
          const pBrand = (p.brand as any)?.name || 'Unknown';
          this.logger.log(`[DEBUG]   - "${p.name}" | brand="${pBrand}" | status="${p.status}" | id=${p._id}`);
        }
        this.logger.log(`[DEBUG] Active marketplaces to scan: ${marketplaces.length}`);
        for (const m of marketplaces) {
          this.logger.log(`[DEBUG]   - "${m.name}" | status="${m.status}" | url=${m.baseUrl}`);
        }
      }

      // Validate products were found if filtering by productId
      if (productId && products.length === 0) {
        this.logger.error(`[DEBUG] No active competitor products found for productId=${productId}. Check if linked products have status != 'active' (see DEBUG logs above).`);
        throw new Error(`No competitor products found for the selected product`);
      }

      await job.updateProgress(25);

      // Step 2: Scrape real prices for each product-marketplace combination
      this.logger.log('Step 2: Scraping competitor prices...');
      let processedLookups = 0;

      // Ensure runId is defined before processing
      if (!runId) {
        throw new Error('Run ID is required for processing');
      }
      const validRunId = runId;

      // Use p-limit for global concurrency control across all products and marketplaces
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pLimit = require('p-limit');
      const limit = pLimit(20); // Limit to 20 concurrent search (Google) lookups globally
      // Browser (Stagehand) lookups are far heavier — cap them separately (default 1).
      const browserLimit = pLimit(Number(process.env.BROWSER_SCAN_CONCURRENCY) || 1);

      // Iterating through products to prepare all lookup tasks
      const allLookupTasks: Promise<any>[] = [];

      for (const product of products) {
        // Check if job was cancelled before queuing tasks for this product
        if (await this.ingestionRunsService.isCancelled(validRunId)) {
          this.logger.log(`Job ${job.id} cancelled by user, stopping price search.`);
          return;
        }

        const brandName = this.getBrandName(product.brand as any);
        const productIngredientContent: Record<string, number> = product.ingredientContent instanceof Map
          ? Object.fromEntries(product.ingredientContent)
          : (product.ingredientContent || {});

        // Queue marketplace searches for this product — pick the acquisition
        // strategy (and its concurrency limiter) per marketplace.
        const productTasks = marketplaces.map((marketplace) => {
          const isBrowser = marketplace.scanStrategy === 'browser';
          const taskLimit = isBrowser ? browserLimit : limit;
          const fetcher: MarketplacePriceFetcher = isBrowser
            ? this.stagehandFetcher
            : this.googleSearchFetcher;

          return taskLimit(async () => {
            try {
              // Check cancellation again inside the task
              if (await this.ingestionRunsService.isCancelled(validRunId)) {
                return { success: false, marketplace: marketplace.name, cancelled: true };
              }

              // Get country config based on marketplace country
              const normalizedCountry = (marketplace.country || DEFAULT_COUNTRY).toUpperCase();
              const config = COUNTRY_SEARCH_CONFIG[normalizedCountry] || COUNTRY_SEARCH_CONFIG[DEFAULT_COUNTRY];

              const SEARCH_CURRENCY_CODE = config.currencyCode;

              this.logger.log(`[${marketplace.name}] Starting ${fetcher.strategy} lookup for "${product.name}"...`);
              const searchStartTime = Date.now();

              let parsed: MarketplacePriceLookup;
              try {
                parsed = await this.withTimeout(
                  fetcher.fetchPrice({ marketplace, product, brandName, country: config }),
                  MARKETPLACE_SEARCH_TIMEOUT_MS,
                  `${fetcher.strategy} lookup timeout for ${product.name} on ${marketplace.name}`,
                );
              } catch (fetchError) {
                this.logger.error(`[${marketplace.name}] ${fetcher.strategy} lookup failed for "${product.name}": ${fetchError.message}`);
                throw fetchError;
              }

              const searchDuration = Date.now() - searchStartTime;
              this.logger.log(`[${marketplace.name}] ${fetcher.strategy} lookup completed in ${searchDuration}ms for "${product.name}"`);

              // Ensure precioConIva is always populated if we have any price
              // The displayed price should always be treated as "with IVA"
              if (!parsed.precioConIva && parsed.precioSinIva) {
                // If we only have precioSinIva, treat it as precioConIva instead
                parsed.precioConIva = parsed.precioSinIva;
                parsed.precioSinIva = null;
              }

              // Track if precioSinIva was calculated vs. scraped
              let precioSinIvaCalculated = false;

              // Calculate precioSinIva if not provided by the scraper
              // Use the marketplace's IVA rate to compute it from precioConIva
              if (parsed.precioConIva && !parsed.precioSinIva && marketplace.ivaRate) {
                parsed.precioSinIva = parsed.precioConIva / (1 + marketplace.ivaRate);
                precioSinIvaCalculated = true;
              }

              // Determine lookup status
              let lookupStatus: 'success' | 'not_found' | 'error' = 'success';
              if (!parsed.inStock || !parsed.precioConIva) {
                lookupStatus = 'not_found';
              }

              // Validate currency is Correct
              if (parsed.currency && parsed.currency.toUpperCase() !== SEARCH_CURRENCY_CODE) {
                this.logger.warn(`[${marketplace.name}] Invalid currency found for "${product.name}": ${parsed.currency}. Ignoring value.`);
                lookupStatus = 'not_found';
                parsed.precioConIva = null;
                parsed.precioSinIva = null;
              }

              // Calculate price per ingredient content (using pre-calculated ingredient content)
              let pricePerIngredientContent: Record<string, number> | undefined;

              if (lookupStatus === 'success' && (parsed.precioConIva || parsed.precioSinIva)) {
                pricePerIngredientContent = {};

                // Price per Ingredient = (precioSinIva or precioConIva) ÷ ingredientContent
                // Use precioSinIva if available, otherwise fall back to precioConIva
                const priceToUse = parsed.precioSinIva || parsed.precioConIva || 0;

                for (const [ingredientId, content] of Object.entries(productIngredientContent)) {
                  const pricePerContent = content > 0 ? priceToUse / content : 0;
                  pricePerIngredientContent[ingredientId] = pricePerContent;
                }
              }

              const normalizedProductUrl = this.normalizeUrl(parsed.productUrl);
              let resolvedProductUrl = marketplace.baseUrl;
              let urlType: MarketplaceUrlType = 'unknown';

              if (normalizedProductUrl) {
                resolvedProductUrl = normalizedProductUrl.toString();
                urlType = classifyMarketplaceUrl(resolvedProductUrl);
              }

              const isCanonicalUrl = isCanonicalProductUrl(urlType);

              let priceConfidence = 0;
              if (lookupStatus === 'success') {
                // Browser-strategy prices are read from the marketplace's own
                // rendered page, so they are domain-verified by construction —
                // credit the domain signal even when we only captured a listing
                // URL (not a product page). A non-canonical browser price still
                // takes the 0.85 penalty below, landing it around 0.79 vs the
                // 0.93 of one with a real product URL.
                const isBrowserStrategy = marketplace.scanStrategy === 'browser';
                const domainMatches = isBrowserStrategy
                  ? true
                  : isCanonicalUrl
                    ? belongsToMarketplaceDomain(resolvedProductUrl, marketplace.baseUrl)
                    : false;
                priceConfidence = calculatePriceConfidence({
                  inStock: Boolean(parsed.inStock),
                  hasPrecioConIva: Boolean(parsed.precioConIva),
                  domainMatches,
                  precioSinIvaCalculated,
                });

                if (!isCanonicalUrl) {
                  priceConfidence = Number(Math.max(0.05, priceConfidence * 0.85).toFixed(2));
                }
              }

              // Store lookup result in ingestion run (including calculated data)
              await this.ingestionRunsService.addLookupResult(validRunId, {
                productId: product._id,
                productName: product.name,
                productBrand: brandName,
                marketplaceId: marketplace._id,
                marketplaceName: marketplace.name,
                url: resolvedProductUrl,
                urlType,
                isCanonicalUrl,
                price: parsed.precioConIva ?? parsed.precioSinIva ?? undefined,
                precioSinIva: parsed.precioSinIva ?? undefined,
                precioSinIvaCalculated,
                precioConIva: parsed.precioConIva ?? undefined,
                ivaRate: marketplace.ivaRate,
                country: marketplace.country,
                ingredientContent: productIngredientContent,
                pricePerIngredientContent,
                currency: 'COP',
                inStock: parsed.inStock,
                scrapedAt: new Date(),
                lookupStatus,
                priceConfidence,
              });

              // Create Price document if lookup was successful
              if (lookupStatus === 'success' && pricePerIngredientContent) {
                await this.pricesService.create({
                  precioSinIva: parsed.precioSinIva || 0,
                  precioConIva: parsed.precioConIva || 0,
                  ingredientContent: productIngredientContent,
                  pricePerIngredientContent,
                  marketplaceId: marketplace._id.toString(),
                  productId: product._id.toString(),
                  ingestionRunId: validRunId.toString(),
                  priceConfidence,
                });
              }

              this.logger.log(
                `✓ ${product.name} on ${marketplace.name}: ${parsed.precioConIva || parsed.precioSinIva ? `sinIVA: $${parsed.precioSinIva || 'N/A'}, conIVA: $${parsed.precioConIva || 'N/A'}` : 'not found'}`,
              );

              // Increment global counter and update progress
              processedLookups++;
              const progressValue = totalLookups > 0
                ? Math.floor((processedLookups / totalLookups) * totalProducts)
                : 0;
              
              // Only update DB progress occasionally to reduce write load
              if (processedLookups % 5 === 0 || processedLookups === totalLookups) {
                await this.ingestionRunsService.updateProgress(validRunId, progressValue);
                
                const progressPercentage = Math.min(
                  70,
                  25 + Math.floor((processedLookups / totalLookups) * 45),
                );
                await job.updateProgress(progressPercentage);
              }

              return { success: true, marketplace: marketplace.name };
            } catch (error) {
              this.logger.error(
                `Failed to search ${product.name} on ${marketplace.name}: ${error.message}`,
              );
              this.logger.error(`Error stack: ${error.stack}`);

              // Store failed lookup immediately in DB
              await this.ingestionRunsService.addLookupResult(validRunId, {
                productId: product._id,
                productName: product.name,
                productBrand: brandName,
                marketplaceId: marketplace._id,
                marketplaceName: marketplace.name,
                url: marketplace.baseUrl,
                urlType: 'unknown',
                isCanonicalUrl: false,
                price: undefined,
                currency: undefined,
                inStock: false,
                scrapedAt: new Date(),
                lookupStatus: 'error',
                priceConfidence: 0,
              });

              processedLookups++;
              // Only update DB progress occasionally to reduce write load
              if (processedLookups % 5 === 0 || processedLookups === totalLookups) {
                 const progressValue = totalLookups > 0
                  ? Math.floor((processedLookups / totalLookups) * totalProducts)
                  : 0;
                await this.ingestionRunsService.updateProgress(validRunId, progressValue);
              }

              return { success: false, marketplace: marketplace.name, error };
            }
          });
        });

        allLookupTasks.push(...productTasks);
      }

      // Wait for all lookup tasks to complete globally
      this.logger.log(`Queued ${allLookupTasks.length} tasks. Waiting for completion...`);
      try {
        await Promise.allSettled(allLookupTasks);
      } finally {
        // Keep the persistent browser alive across runs (launching a fresh one
        // per run is what dies in the container); just free this run's tabs.
        await this.stagehandFetcher.cleanupAfterRun();
      }

      this.logger.log(
        `Completed ${processedLookups} lookups across ${totalMarketplaces} marketplaces`,
      );

      await job.updateProgress(70);

      // Check cancellation before starting recommendations
      if (await this.ingestionRunsService.isCancelled(validRunId)) {
        this.logger.log(`Job ${job.id} cancelled by user, stopping before recommendations.`);
        return;
      }

      // Step 4: Generate price recommendations for Nutribiotics products
      this.logger.log('Step 4: Generating price recommendations for Nutribiotics products...');

      if (!nutribioticsBrand) {
        this.logger.warn('Nutribiotics brand not found, skipping recommendations');
      } else {
        // If a specific productId was provided, only generate recommendations for that product
        const nutriQuery: any = { brand: nutribioticsBrand._id, status: 'active' };
        if (productId) {
          nutriQuery._id = new Types.ObjectId(productId);
        }

        const nutribioticsProducts = await this.productModel
          .find(nutriQuery)
          .populate({ path: 'brand', select: 'name status' })
          .exec();

        this.logger.log(`Found ${nutribioticsProducts.length} Nutribiotics products to analyze`);
        let recommendationsProcessed = 0;

        for (const nutriProduct of nutribioticsProducts) {
          if (await this.ingestionRunsService.isCancelled(validRunId)) {
            this.logger.log(`Job ${job.id} cancelled by user, stopping recommendations.`);
            return;
          }

          try {
            // Get current price for this Nutribiotics product
            const currentPrice = await this.priceModel
              .findOne({ productId: nutriProduct._id })
              .sort({ createdAt: -1 })
              .exec();

            // Check if Nutribiotics product has a price set
            const hasCurrentPrice = currentPrice?.precioConIva != null;

            if (!hasCurrentPrice) {
              this.logger.warn(`Product ${nutriProduct.name} has no price set. Skipping recommendation.`);
              await this.recommendationsService.upsertRecommendation({
                productId: nutriProduct._id.toString(),
                ingestionRunId: validRunId.toString(),
                currentPrice: null,
                recommendation: 'keep',
                recommendationReasoning: 'El precio no fue establecido por lo tanto no se puede hacer una recomendación.',
              });

              recommendationsProcessed++;
              const recProgress = Math.min(
                95,
                75 + Math.floor((recommendationsProcessed / nutribioticsProducts.length) * 20),
              );
              await job.updateProgress(recProgress);
              continue;
            }

            // Find all competitor products (products that compare to this one)
            const competitorProducts = await this.productModel
              .find({
                comparedTo: nutriProduct._id,
                brand: { $ne: nutribioticsBrand._id },
                status: 'active'
              })
              .populate({ path: 'brand', select: 'name status' })
              .exec();

            if (competitorProducts.length === 0) {
              const reason = !hasCurrentPrice
                ? `El producto ${nutriProduct.name} no tiene un precio actual configurado y no se encontraron productos competidores. Configure el precio del producto para poder generar recomendaciones.`
                : `No se encontraron productos competidores vinculados a ${nutriProduct.name}. Se recomienda mantener el precio actual.`;

              this.logger.log(`No competitor products found for ${nutriProduct.name}, defaulting recommendation to keep`);
              await this.recommendationsService.upsertRecommendation({
                productId: nutriProduct._id.toString(),
                ingestionRunId: validRunId.toString(),
                currentPrice: currentPrice?.precioConIva ?? null,
                recommendation: 'keep',
                recommendationReasoning: reason,
              });
              continue;
            }

            // Gather all competitor prices
            const competitorPriceData: CompetitorPriceData[] = [];
            const confidentPrices: { price: number; confidence: number }[] = [];
            let totalPricesFound = 0;
            let lowConfidencePricesCount = 0;
            const lowConfidenceDetails: { marketplace: string; confidence: number }[] = [];

            for (const comp of competitorProducts) {
              const compPrices = await this.priceModel
                .find({
                  productId: new Types.ObjectId(comp._id),
                  ingestionRunId: validRunId,
                })
                .sort({ createdAt: -1 })
                .populate('marketplaceId')
                .exec();

              // Group by marketplace and take most recent entry
              const pricesByMarketplace = new Map<string, PriceDocument>();
              for (const price of compPrices) {
                if (!price.marketplaceId) {
                  continue;
                }

                const mkId = price.marketplaceId.toString();
                if (!pricesByMarketplace.has(mkId)) {
                  pricesByMarketplace.set(mkId, price);
                }
              }

              for (const price of pricesByMarketplace.values()) {
                const marketplace = await this.marketplaceModel.findById(price.marketplaceId).exec();
                const confidence = price.priceConfidence ?? 0;

                totalPricesFound++;

                // Track low confidence prices for better error messaging
                if (confidence < MIN_RECOMMENDATION_PRICE_CONFIDENCE) {
                  lowConfidencePricesCount++;
                  lowConfidenceDetails.push({
                    marketplace: marketplace?.name || 'Unknown',
                    confidence: confidence,
                  });
                  continue;
                }

                const compIngredientContent = comp.ingredientContent instanceof Map
                  ? Object.fromEntries(comp.ingredientContent)
                  : (comp.ingredientContent || {});
                const compPricePerIngredient = price.pricePerIngredientContent instanceof Map
                  ? Object.fromEntries(price.pricePerIngredientContent)
                  : (price.pricePerIngredientContent || {});

                competitorPriceData.push({
                  marketplaceName: marketplace?.name || 'Unknown',
                  productName: comp.name,
                  brandName: this.getBrandName(comp.brand as any),
                  precioConIva: price.precioConIva,
                  precioSinIva: price.precioSinIva,
                  pricePerIngredientContent: compPricePerIngredient,
                  ingredientContent: compIngredientContent,
                });

                confidentPrices.push({ price: price.precioConIva, confidence });
              }
            }

            if (confidentPrices.length === 0) {
              // Build a detailed reason based on what was found
              let detailedReason: string;
              const noPriceWarning = !hasCurrentPrice
                ? ` Además, el producto ${nutriProduct.name} no tiene un precio actual configurado.`
                : '';

              if (totalPricesFound === 0) {
                detailedReason = !hasCurrentPrice
                  ? `El producto ${nutriProduct.name} no tiene un precio actual configurado y no se encontraron precios de competidores. Configure el precio del producto para poder generar recomendaciones.`
                  : `No se encontraron precios de competidores para este producto. Se recomienda mantener el precio actual.`;
              } else if (lowConfidencePricesCount > 0) {
                const marketplacesList = lowConfidenceDetails.slice(0, 3).map(d => `${d.marketplace} (${Math.round(d.confidence * 100)}%)`).join(', ');
                const moreText = lowConfidenceDetails.length > 3 ? ` y ${lowConfidenceDetails.length - 3} más` : '';
                detailedReason = `Se encontraron ${lowConfidencePricesCount} precios de competidores, pero ninguno alcanzó el umbral de confianza mínimo (${MIN_RECOMMENDATION_PRICE_CONFIDENCE * 100}%). Precios con baja confianza: ${marketplacesList}${moreText}.${noPriceWarning} Se recomienda mantener el precio actual hasta obtener datos más confiables.`;
              } else {
                detailedReason = GENERIC_KEEP_REASON + noPriceWarning;
              }

              this.logger.warn(`No high-confidence competitor prices found for ${nutriProduct.name} (found ${totalPricesFound} prices, ${lowConfidencePricesCount} below threshold), defaulting recommendation to keep`);
              await this.recommendationsService.upsertRecommendation({
                productId: nutriProduct._id.toString(),
                ingestionRunId: validRunId.toString(),
                currentPrice: currentPrice?.precioConIva ?? null,
                recommendation: 'keep',
                recommendationReasoning: detailedReason,
              });
              continue;
            }

            this.logger.log(`Found ${confidentPrices.length} competitor prices >= ${MIN_RECOMMENDATION_PRICE_CONFIDENCE} confidence for ${nutriProduct.name}`);

            // Calculate min/max/weighted avg
            const priceValues = confidentPrices.map((entry) => entry.price);
            const minCompetitorPrice = Math.min(...priceValues);
            const maxCompetitorPrice = Math.max(...priceValues);
            const totalConfidence = confidentPrices.reduce((sum, entry) => sum + entry.confidence, 0);
            const avgCompetitorPrice =
              totalConfidence > 0
                ? confidentPrices.reduce((sum, entry) => sum + entry.price * entry.confidence, 0) / totalConfidence
                : priceValues.reduce((sum, value) => sum + value, 0) / priceValues.length;

            // Get ingredient content
            const ingredientContent = nutriProduct.ingredientContent instanceof Map
              ? Object.fromEntries(nutriProduct.ingredientContent)
              : (nutriProduct.ingredientContent || {});

            // Generate recommendation
            this.logger.log(`Generating recommendation for ${nutriProduct.name}...`);
            const recommendation = await this.recommendationService.generateRecommendation({
              productName: nutriProduct.name,
              currentPrice: currentPrice?.precioConIva || null,
              ingredientContent,
              competitorPrices: competitorPriceData,
              minCompetitorPrice,
              maxCompetitorPrice,
              avgCompetitorPrice,
            });

            await this.recommendationsService.upsertRecommendation({
              productId: nutriProduct._id.toString(),
              ingestionRunId: validRunId.toString(),
              currentPrice: currentPrice?.precioConIva ?? null,
              recommendation: recommendation.recommendation,
              recommendationReasoning: recommendation.reasoning,
              recommendedPrice: recommendation.suggestedPrice,
            });
            this.logger.log(
              `✓ Stored recommendation for ${nutriProduct.name}: ${recommendation.recommendation}`,
            );
          } catch (error) {
            this.logger.error(
              `Failed to generate recommendation for ${nutriProduct.name}: ${error.message}`,
            );
          }

          recommendationsProcessed++;
          const recProgress = Math.min(
            95,
            75 + Math.floor((recommendationsProcessed / nutribioticsProducts.length) * 20),
          );
          await job.updateProgress(recProgress);
        }

        this.logger.log(`Completed recommendations for ${nutribioticsProducts.length} products`);
      }

      // Mark the run as completed
      await job.updateProgress(100);
      await this.ingestionRunsService.updateProgress(runId, totalProducts);
      await this.ingestionRunsService.markAsCompleted(runId);

      this.logger.log(
        `Price comparison job ${job.id} completed successfully. Triggered by: ${triggeredBy || 'system'}, at ${timestamp}. Run ID: ${runId}`,
      );

      return;
    } catch (error) {
      this.logger.error(
        `Failed to process price comparison job ${job.id}: ${error.message}`,
      );

      if (runId) {
        await this.ingestionRunsService.markAsFailed(
          runId,
          error.message,
          error.stack,
        );
      }

      throw error;
    }
  }

  private getBrandName(brand: Types.ObjectId | BrandDocument | string | undefined): string {
    if (!brand) {
      return '';
    }

    if (typeof brand === 'string') {
      return brand;
    }

    if (brand instanceof Types.ObjectId) {
      return brand.toString();
    }

    return brand.name;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private normalizeUrl(value: string | null | undefined): URL | null {
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

}
