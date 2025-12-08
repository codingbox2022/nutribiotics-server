import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { IngestionRunsService } from '../ingestion-runs/ingestion-runs.service';
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

      await this.delay(2000);
      await job.updateProgress(25);

      // Step 2: Simulate scraping competitor prices for each product-marketplace combination
      this.logger.log('Step 2: Scraping competitor prices...');
      let processedProducts = 0;
      const sampleSize = Math.min(10, totalProducts); // Sample first 10 products for mock results

      for (let i = 0; i < sampleSize; i++) {
        const product = products[i];
        const marketplace =
          marketplaces[i % totalMarketplaces] || marketplaces[0];

        if (!marketplace) continue;

        // Simulate network delay for each lookup (500ms - 1.5s per lookup)
        const lookupDelay = Math.floor(Math.random() * 1000) + 500;
        this.logger.log(
          `Scraping ${product.name} from ${marketplace.name}...`,
        );
        await this.delay(lookupDelay);

        // Simulate lookup for this product-marketplace pair
        await this.ingestionRunsService.addLookupResult(runId, {
          productId: product._id,
          productName: product.name,
          marketplaceId: marketplace._id,
          marketplaceName: marketplace.name,
          url: `${marketplace.baseUrl}/product/${product.name.toLowerCase().replace(/\s+/g, '-')}`,
          price:
            Math.random() > 0.2
              ? Math.floor(Math.random() * 50000 + 10000)
              : undefined,
          currency: 'COP',
          inStock: Math.random() > 0.3,
          scrapedAt: new Date(),
          lookupStatus: Math.random() > 0.1 ? 'success' : 'not_found',
        });

        processedProducts++;
        await this.ingestionRunsService.updateProgress(runId, processedProducts);
      }

      await job.updateProgress(50);
      this.logger.log(`Scraped prices from ${totalMarketplaces} marketplaces`);

      // Step 3: Simulate price analysis
      this.logger.log('Step 3: Analyzing price differences...');
      await this.delay(2000);
      await job.updateProgress(75);
      this.logger.log('Calculated price indexes and alerts');

      // Step 4: Simulate updating database
      this.logger.log('Step 4: Updating comparison data...');
      await this.delay(2000);
      await job.updateProgress(100);
      this.logger.log('Updated database with new comparison results');

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
