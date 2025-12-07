import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Types } from 'mongoose';
import { IngestionRunsService } from '../ingestion-runs/ingestion-runs.service';

export interface PriceComparisonJobData {
  triggeredBy?: string;
  timestamp: Date;
  ingestionRunId?: string;
}

@Processor('price-comparison')
export class PriceComparisonProcessor extends WorkerHost {
  private readonly logger = new Logger(PriceComparisonProcessor.name);

  constructor(private readonly ingestionRunsService: IngestionRunsService) {
    super();
  }

  async process(job: Job<PriceComparisonJobData>): Promise<void> {
    this.logger.log(`Starting price comparison job ${job.id}`);
    const { triggeredBy, timestamp, ingestionRunId } = job.data;

    let runId: Types.ObjectId | string | undefined;

    try {
      // Create or use existing ingestion run
      if (ingestionRunId) {
        runId = ingestionRunId;
        await this.ingestionRunsService.markAsRunning(runId);
      } else {
        // Create new ingestion run with mock data
        const run = await this.ingestionRunsService.create(
          triggeredBy || 'system',
          150, // totalProducts (mocked)
          750, // totalLookups (150 products × 5 marketplaces)
        );
        runId = run._id;
        await this.ingestionRunsService.markAsRunning(runId);
      }

      // Step 1: Simulate fetching products
      this.logger.log('Step 1: Fetching products from database...');
      await this.delay(2000);
      await job.updateProgress(25);
      this.logger.log('Found 150 products to compare');
      await this.ingestionRunsService.updateProgress(runId, 0);

      // Step 2: Simulate scraping competitor prices
      this.logger.log('Step 2: Scraping competitor prices...');
      await this.delay(3000);
      await job.updateProgress(50);
      this.logger.log('Scraped prices from 5 marketplaces');

      // Add some mock lookup results
      const mockProductId = new Types.ObjectId();
      const mockMarketplaceId = new Types.ObjectId();

      for (let i = 0; i < 10; i++) {
        await this.ingestionRunsService.addLookupResult(runId, {
          productId: mockProductId,
          productName: `Product ${i + 1}`,
          marketplaceId: mockMarketplaceId,
          marketplaceName: `Marketplace ${(i % 5) + 1}`,
          url: `https://example.com/product-${i}`,
          price: Math.random() > 0.2 ? Math.floor(Math.random() * 10000) : undefined,
          currency: 'COP',
          inStock: Math.random() > 0.3,
          scrapedAt: new Date(),
          lookupStatus: Math.random() > 0.1 ? 'success' : 'not_found',
        });
      }

      await this.ingestionRunsService.updateProgress(runId, 75);

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

      await this.ingestionRunsService.updateProgress(runId, 150);
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
