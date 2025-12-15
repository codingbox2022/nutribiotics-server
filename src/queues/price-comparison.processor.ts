import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { IngestionRunsService } from '../ingestion-runs/ingestion-runs.service';
import { PricesService } from '../prices/prices.service';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  Marketplace,
  MarketplaceDocument,
} from '../marketplaces/schemas/marketplace.schema';

export interface PriceComparisonJobData {
  triggeredBy?: string;
  timestamp: Date;
  ingestionRunId?: string;
}

@Processor('price-comparison')
export class PriceComparisonProcessor extends WorkerHost {
  private readonly logger = new Logger(PriceComparisonProcessor.name);

  constructor(
    private readonly ingestionRunsService: IngestionRunsService,
    private readonly pricesService: PricesService,
    @InjectModel(Product.name)
    private productModel: Model<ProductDocument>,
    @InjectModel(Marketplace.name)
    private marketplaceModel: Model<MarketplaceDocument>,
  ) {
    super();
  }

  async process(job: Job<PriceComparisonJobData>): Promise<void> {
    this.logger.log(`Starting price comparison job ${job.id}`);
    const { triggeredBy, timestamp, ingestionRunId } = job.data;

    let runId: Types.ObjectId | string | undefined;

    try {
      // Step 1: Fetch real products and marketplaces from database (excluding Nutribiotics products)
      this.logger.log('Step 1: Fetching products from database...');
      const [products, marketplaces] = await Promise.all([
        this.productModel.find({ brand: { $not: { $regex: /^nutribiotics$/i } } }).exec(),
        this.marketplaceModel.find({ status: 'active' }).exec(),
      ]);

      const totalProducts = products.length;
      const totalMarketplaces = marketplaces.length;
      const totalLookups = totalProducts * totalMarketplaces;

      this.logger.log(
        `Found ${totalProducts} products and ${totalMarketplaces} marketplaces (${totalLookups} total lookups)`,
      );

      // Create or use existing ingestion run
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
        productUrl: z.string().optional(),
        productName: z.string().optional(),
        inStock: z.boolean().default(false),
      });

      // Iterate through products one at a time
      for (const product of products) {
        this.logger.log(
          `Processing ${product.name} by ${product.brand} across ${totalMarketplaces} marketplaces in parallel...`,
        );

        // Launch all marketplace searches for this product in parallel
        const marketplaceSearchPromises = marketplaces.map(
          async (marketplace) => {
            try {
              const prompt = `Look for this product "${product.name}" of brand "${product.brand}" on the marketplace "${marketplace.name}" and get me the current prices (both with and without tax/IVA/VAT if available). If the product is not found, respond with inStock as false.

      Return ONLY a valid JSON object (no markdown, no extra text) with the following fields:
      - precioSinIva (number or null): Price without tax/IVA/VAT if shown on the page
      - precioConIva (number or null): Price with tax/IVA/VAT included (usually the main displayed price)
      - productUrl (string): URL to the product page
      - productName (string): The exact product name found
      - inStock (boolean): Whether the product is available

      If only one price is shown, put it in precioConIva and set precioSinIva to null.
    `;

              const result = await generateText({
                model: openai('gpt-4o'),
                prompt,
                tools: {
                  web_search: openai.tools.webSearch({}),
                },
              });

              // Try to parse JSON response, handle malformed JSON gracefully
              let parsed: z.infer<typeof searchSchema>;
              try {
                // Remove markdown code blocks if present
                let jsonText = result.text.trim();
                if (jsonText.startsWith('```')) {
                  jsonText = jsonText.replace(/```json?\n?/g, '').replace(/```\n?$/g, '');
                }

                const jsonResponse = JSON.parse(jsonText);
                parsed = searchSchema.parse(jsonResponse);
              } catch (parseError) {
                this.logger.error(
                  `Failed to parse LLM response for ${product.name} on ${marketplace.name}: ${parseError.message}`,
                );
                throw new Error(`Invalid JSON response: ${parseError.message}`);
              }

              // Determine lookup status
              let lookupStatus: 'success' | 'not_found' | 'error' = 'success';
              if (!parsed.inStock || (!parsed.precioSinIva && !parsed.precioConIva)) {
                lookupStatus = 'not_found';
              }

              // Store lookup result in ingestion run
              await this.ingestionRunsService.addLookupResult(validRunId, {
                productId: product._id,
                productName: product.name,
                marketplaceId: marketplace._id,
                marketplaceName: marketplace.name,
                url: parsed.productUrl || marketplace.baseUrl,
                price: parsed.precioConIva ?? parsed.precioSinIva ?? undefined, // Use precioConIva for backward compatibility with lookup results
                currency: 'COP', // Default currency, can be enhanced
                inStock: parsed.inStock,
                scrapedAt: new Date(),
                lookupStatus,
              });

              // Create Price document if lookup was successful
              if (lookupStatus === 'success' && (parsed.precioConIva || parsed.precioSinIva)) {
                await this.pricesService.create({
                  precioSinIva: parsed.precioSinIva || 0,
                  precioConIva: parsed.precioConIva || 0,
                  marketplaceId: marketplace._id.toString(),
                  productId: product._id.toString(),
                  ingestionRunId: validRunId.toString(),
                });
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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
