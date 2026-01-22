import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { generateText } from 'ai';
import { z } from 'zod';
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
import { google } from 'src/providers/googleAiProvider';
import { belongsToMarketplaceDomain, calculatePriceConfidence } from '../common/utils/price-confidence.util';

export interface PriceComparisonJobData {
  triggeredBy?: string;
  timestamp: Date;
  ingestionRunId?: string;
  productId?: string;
}

const MIN_RECOMMENDATION_PRICE_CONFIDENCE = 0.6;

@Processor('price-comparison')
export class PriceComparisonProcessor extends WorkerHost {
  private readonly logger = new Logger(PriceComparisonProcessor.name);

  constructor(
    private readonly ingestionRunsService: IngestionRunsService,
    private readonly pricesService: PricesService,
    private readonly recommendationService: RecommendationService,
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
        .findOne({ name: { $regex: /^nutribiotics$/i } })
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

        // Search for all competitor products that compare to this Nutribiotics product
        this.logger.log(`Finding all competitor products comparable to Nutribiotics product ${productId}...`);
        productQuery = {
          status: 'active',
          comparedTo: new Types.ObjectId(productId),
        };

        // Exclude Nutribiotics brand if it exists
        if (nutribioticsBrand) {
          productQuery.brand = { $ne: nutribioticsBrand._id };
        }
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
            'searchCapabilities.googleIndexedProducts': true,
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
        );
        runId = run._id;
        await this.ingestionRunsService.markAsRunning(runId);
      }

      // Validate products were found if filtering by productId
      if (productId && products.length === 0) {
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

      // Schema for LLM web search response
      const searchSchema = z.object({
        precioSinIva: z.number().nullable().optional(),
        precioConIva: z.number().nullable().optional(),
        productUrl: z.string().nullable().optional(),
        productName: z.string().nullable().optional(),
        inStock: z.boolean().default(false),
      });

      // Iterate through products one at a time
      for (const product of products) {
        const brandName = this.getBrandName(product.brand as any);
        this.logger.log(
          `Processing ${product.name} by ${brandName} across ${totalMarketplaces} marketplaces in parallel...`,
        );

        // Use pre-calculated ingredient content from product
        const productIngredientContent: Record<string, number> = product.ingredientContent instanceof Map
          ? Object.fromEntries(product.ingredientContent)
          : (product.ingredientContent || {});

        // Launch all marketplace searches for this product in parallel
        const marketplaceSearchPromises = marketplaces.map(
          async (marketplace) => {
            try {
                    const prompt = `You can assume the marketplace "${marketplace.name}" has searchable, Google-indexed product pages. Find the closest available match (exact or equivalent) for "${product.name}" from brand "${brandName}". Accept equivalent product sizes or bundles if they clearly represent the same item.

                  Only return inStock as false when you have strong evidence that the product and its close equivalents are unavailable after searching multiple result pages. Otherwise provide the best available match.

                  Return ONLY a valid JSON object (no markdown, no extra text) with the following fields:
                  - precioSinIva (number or null): Price without tax/IVA/VAT if shown on the page
                  - precioConIva (number or null): Price with tax/IVA/VAT included (usually the main displayed price)
                  - productUrl (string): URL to the product page
                  - productName (string): The exact product name found
                  - inStock (boolean): Whether the product is available

                  If only one price is shown, put it in precioConIva and set precioSinIva to null.`;

              const result = await generateText({
                model: google('gemini-3-pro-preview'),
                prompt,
                tools: {
                  google_search: google.tools.googleSearch({}),
                }
              });

              // Try to parse JSON response, handle malformed JSON gracefully
              let parsed: z.infer<typeof searchSchema>;
              try {
                // Remove markdown code blocks if present
                let jsonText = result.text.trim();
                if (jsonText.startsWith('```')) {
                  jsonText = jsonText.replace(/```json?\n?/g, '').replace(/```\n?$/g, '');
                }

                // Extract only the JSON object (everything between first { and last })
                const firstBrace = jsonText.indexOf('{');
                const lastBrace = jsonText.lastIndexOf('}');
                if (firstBrace !== -1 && lastBrace !== -1) {
                  jsonText = jsonText.substring(firstBrace, lastBrace + 1);
                }

                const jsonResponse = JSON.parse(jsonText);
                parsed = searchSchema.parse(jsonResponse);
              } catch (parseError) {
                this.logger.error(
                  `Failed to parse LLM response for ${product.name} on ${marketplace.name}: ${parseError.message}`,
                );
                this.logger.debug(`Raw response: ${result.text}`);
                throw new Error(`Invalid JSON response: ${parseError.message}`);
              }

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

              let priceConfidence = 0;
              if (lookupStatus === 'success') {
                const domainMatches = belongsToMarketplaceDomain(
                  parsed.productUrl,
                  marketplace.baseUrl,
                );
                priceConfidence = calculatePriceConfidence({
                  inStock: Boolean(parsed.inStock),
                  hasPrecioConIva: Boolean(parsed.precioConIva),
                  domainMatches,
                  precioSinIvaCalculated,
                });
              }

              // Store lookup result in ingestion run (including calculated data)
              // Use marketplace's IVA rate and country instead of asking LLM
              await this.ingestionRunsService.addLookupResult(validRunId, {
                productId: product._id,
                productName: product.name,
                productBrand: brandName,
                marketplaceId: marketplace._id,
                marketplaceName: marketplace.name,
                url: parsed.productUrl || marketplace.baseUrl,
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
              });

              // Create Price document if lookup was successful
              if (lookupStatus === 'success' && pricePerIngredientContent) {
                const createdPrice = await this.pricesService.create({
                  precioSinIva: parsed.precioSinIva || 0,
                  precioConIva: parsed.precioConIva || 0,
                  ingredientContent: productIngredientContent,
                  pricePerIngredientContent,
                  marketplaceId: marketplace._id.toString(),
                  productId: product._id.toString(),
                  ingestionRunId: validRunId.toString(),
                  priceConfidence,
                });
                this.logger.debug(`Created price ${createdPrice._id} for product ${product._id} (${product.name})`);
              }

              this.logger.log(
                `✓ ${product.name} on ${marketplace.name}: ${parsed.precioConIva || parsed.precioSinIva ? `sinIVA: $${parsed.precioSinIva || 'N/A'}, conIVA: $${parsed.precioConIva || 'N/A'}` : 'not found'}`,
              );

              return { success: true, marketplace: marketplace.name };
            } catch (error) {
              this.logger.error(
                `Failed to search ${product.name} on ${marketplace.name}: ${error.message}`,
              );

              // Store failed lookup immediately in DB
              await this.ingestionRunsService.addLookupResult(validRunId, {
                productId: product._id,
                productName: product.name,
                productBrand: brandName,
                marketplaceId: marketplace._id,
                marketplaceName: marketplace.name,
                url: marketplace.baseUrl,
                price: undefined,
                currency: undefined,
                inStock: false,
                scrapedAt: new Date(),
                lookupStatus: 'error',
              });

              return { success: false, marketplace: marketplace.name, error };
            }
          },
        );

        // Wait for all marketplace searches for this product to complete
        const results = await Promise.allSettled(marketplaceSearchPromises);

        processedLookups += results.length;

        // Update progress after completing all marketplaces for this product
        await this.ingestionRunsService.updateProgress(
          validRunId,
          Math.floor((processedLookups / totalLookups) * totalProducts),
        );

        const progressPercentage = Math.min(
          75,
          25 + Math.floor((processedLookups / totalLookups) * 50),
        );
        await job.updateProgress(progressPercentage);

        this.logger.log(
          `Completed ${product.name}: ${results.length} marketplace lookups`,
        );
      }

      this.logger.log(
        `Completed ${processedLookups} lookups across ${totalMarketplaces} marketplaces`,
      );

      await job.updateProgress(75);

      // Step 4: Generate price recommendations for Nutribiotics products
      this.logger.log('Step 4: Generating price recommendations for Nutribiotics products...');

      if (!nutribioticsBrand) {
        this.logger.warn('Nutribiotics brand not found, skipping recommendations');
      } else {
        const nutribioticsProducts = await this.productModel
          .find({ brand: nutribioticsBrand._id, status: 'active' })
          .populate({ path: 'brand', select: 'name status' })
          .exec();

        this.logger.log(`Found ${nutribioticsProducts.length} Nutribiotics products to analyze`);

        for (const nutriProduct of nutribioticsProducts) {
          try {
            // Get current price for this Nutribiotics product
            const currentPrice = await this.priceModel
              .findOne({ productId: nutriProduct._id })
              .sort({ createdAt: -1 })
              .exec();

            // Find all competitor products (products that compare to this one)
            this.logger.debug(`Looking for competitors with comparedTo: ${nutriProduct._id}`);
            const competitorProducts = await this.productModel
              .find({
                comparedTo: nutriProduct._id,
                brand: { $ne: nutribioticsBrand._id },
                status: 'active'
              })
              .populate({ path: 'brand', select: 'name status' })
              .exec();

            this.logger.debug(`Found ${competitorProducts.length} competitor products`);

            if (competitorProducts.length === 0) {
              this.logger.log(`No competitor products found for ${nutriProduct.name}, skipping recommendation`);
              continue;
            }

            // Gather all competitor prices
            const competitorPriceData: CompetitorPriceData[] = [];
            const confidentPrices: { price: number; confidence: number }[] = [];

            for (const comp of competitorProducts) {
              this.logger.debug(`Checking prices for competitor: ${comp.name} (${comp._id})`);
              const compPrices = await this.priceModel
                .find({ productId: new Types.ObjectId(comp._id) })
                .sort({ createdAt: -1 })
                .populate('marketplaceId')
                .exec();

              this.logger.debug(`Found ${compPrices.length} prices for ${comp.name}`);

              // Group by marketplace and take most recent high-confidence entry
              const pricesByMarketplace = new Map<string, PriceDocument>();
              for (const price of compPrices) {
                if (!price.marketplaceId) {
                  continue;
                }

                const confidence = price.priceConfidence ?? 0;
                if (confidence < MIN_RECOMMENDATION_PRICE_CONFIDENCE) {
                  continue;
                }

                const mkId = price.marketplaceId.toString();
                if (!pricesByMarketplace.has(mkId)) {
                  pricesByMarketplace.set(mkId, price);
                }
              }

              for (const price of pricesByMarketplace.values()) {
                const marketplace = await this.marketplaceModel.findById(price.marketplaceId).exec();
                const compIngredientContent = comp.ingredientContent instanceof Map
                  ? Object.fromEntries(comp.ingredientContent)
                  : (comp.ingredientContent || {});
                const compPricePerIngredient = price.pricePerIngredientContent instanceof Map
                  ? Object.fromEntries(price.pricePerIngredientContent)
                  : (price.pricePerIngredientContent || {});
                const confidence = price.priceConfidence ?? 0;

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
              this.logger.warn(`No high-confidence competitor prices found for ${nutriProduct.name} (found ${competitorProducts.length} competitor products but none met the confidence threshold), skipping recommendation`);
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

            // Update or create price with recommendation
            if (currentPrice) {
              currentPrice.recommendation = recommendation.recommendation;
              currentPrice.recommendationReasoning = recommendation.reasoning;
              currentPrice.recommendedPrice = recommendation.suggestedPrice;
              await currentPrice.save();
              this.logger.log(
                `✓ Updated recommendation for ${nutriProduct.name}: ${recommendation.recommendation}`,
              );
            } else {
              // Create a new price entry with recommendation only
              await this.pricesService.create({
                precioSinIva: 0,
                precioConIva: 0,
                ingredientContent: ingredientContent,
                pricePerIngredientContent: {},
                marketplaceId: null as any,
                productId: nutriProduct._id.toString(),
                ingestionRunId: validRunId.toString(),
                recommendation: recommendation.recommendation,
                recommendationReasoning: recommendation.reasoning,
                recommendedPrice: recommendation.suggestedPrice,
              });
              this.logger.log(
                `✓ Created recommendation for ${nutriProduct.name}: ${recommendation.recommendation}`,
              );
            }
          } catch (error) {
            this.logger.error(
              `Failed to generate recommendation for ${nutriProduct.name}: ${error.message}`,
            );
          }
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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
