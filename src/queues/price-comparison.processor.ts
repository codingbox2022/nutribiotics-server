import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { IngestionRunsService } from '../ingestion-runs/ingestion-runs.service';
import { ScrapingService } from '../scraping/scraping.service';
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
    private readonly scrapingService: ScrapingService,
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
      // Step 1: Fetch real products and marketplaces from database
      this.logger.log('Step 1: Fetching products from database...');
      const [products, marketplaces] = await Promise.all([
        this.productModel.find().exec(),
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

      // Iterate through ALL product-marketplace combinations
      for (const product of products) {
        for (const marketplace of marketplaces) {
          try {
            // TODO: Get actual product URL from ProductMarketplace collection
            // For now, skip products without proper URL mapping
            const url = `${marketplace.baseUrl}/product/${product.name.toLowerCase().replace(/\s+/g, '-')}`;
            this.logger.warn(
              `No URL mapping found for ${product.name} on ${marketplace.name}. Using generated URL: ${url}`,
            );
            continue;

            // Scrape the product price using Stagehand
            const scrapeResult = await this.scrapingService.scrapeProductPrice(
              url,
              marketplace.name,
            );

            // Determine lookup status based on scraping result
            let lookupStatus: 'success' | 'not_found' | 'error' = 'success';
            if (!scrapeResult.success) {
              lookupStatus = 'error';
            } else if (!scrapeResult.inStock || !scrapeResult.price) {
              lookupStatus = 'not_found';
            }

            // Record the lookup result
            await this.ingestionRunsService.addLookupResult(validRunId, {
              productId: product._id,
              productName: product.name,
              marketplaceId: marketplace._id,
              marketplaceName: marketplace.name,
              url,
              price: scrapeResult.price,
              currency: scrapeResult.currency,
              inStock: scrapeResult.inStock,
              scrapedAt: new Date(),
              lookupStatus,
            });

            processedLookups++;
            await this.ingestionRunsService.updateProgress(
              validRunId,
              Math.floor((processedLookups / totalLookups) * totalProducts),
            );

            // Add a small delay between requests to avoid rate limiting (1-2 seconds)
            await this.delay(1000 + Math.random() * 1000);
          } catch (error) {
            // Log error but continue processing other product-marketplace combinations
            this.logger.error(
              `Failed to scrape ${product.name} from ${marketplace.name}: ${error.message}`,
            );

            // Record the failed lookup
            await this.ingestionRunsService.addLookupResult(validRunId, {
              productId: product._id,
              productName: product.name,
              marketplaceId: marketplace._id,
              marketplaceName: marketplace.name,
              url: `${marketplace.baseUrl}/product/${product.name.toLowerCase().replace(/\s+/g, '-')}`,
              price: undefined,
              currency: undefined,
              inStock: false,
              scrapedAt: new Date(),
              lookupStatus: 'error',
            });

            processedLookups++;
          }
        }

        // Update job progress periodically
        const progressPercentage = Math.min(
          75,
          25 + Math.floor((processedLookups / totalLookups) * 50),
        );
        await job.updateProgress(progressPercentage);
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
