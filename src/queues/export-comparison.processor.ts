import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PricesService } from '../prices/prices.service';
import { ExportCacheService } from '../prices/export-cache.service';

export interface ExportComparisonJobData {
  ingestionRunId: string;
  triggeredBy?: string;
  timestamp: Date;
}

export interface ExportComparisonResult {
  ready: true;
  ingestionRunId: string;
}

@Processor('export-comparison')
export class ExportComparisonProcessor extends WorkerHost {
  private readonly logger = new Logger(ExportComparisonProcessor.name);

  constructor(
    private readonly pricesService: PricesService,
    private readonly exportCacheService: ExportCacheService,
  ) {
    super();
  }

  async process(job: Job<ExportComparisonJobData>): Promise<ExportComparisonResult> {
    const { ingestionRunId } = job.data;
    this.logger.log(`Starting export comparison job ${job.id} for run ${ingestionRunId}`);

    try {
      const buffer = await this.pricesService.exportComparisonResultsToExcel(
        ingestionRunId,
        async (percent) => {
          await job.updateProgress(percent);
        },
      );
      this.exportCacheService.set(job.id!, buffer);
      await job.updateProgress(100);
      this.logger.log(`Export comparison job ${job.id} completed`);
      return { ready: true, ingestionRunId };
    } catch (error) {
      this.logger.error(`Export comparison job ${job.id} failed: ${error.message}`);
      throw error;
    }
  }
}
