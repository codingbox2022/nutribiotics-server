import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsService } from './notifications.service';
import { PriceComparisonProcessor } from './price-comparison.processor';
import { QueuesController } from './queues.controller';
import { IngestionRunsModule } from '../ingestion-runs/ingestion-runs.module';
import { ScrapingModule } from '../scraping/scraping.module';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import {
  Marketplace,
  MarketplaceSchema,
} from '../marketplaces/schemas/marketplace.schema';

@Module({
  imports: [
    IngestionRunsModule,
    ScrapingModule,
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: Marketplace.name, schema: MarketplaceSchema },
    ]),
    BullModule.registerQueue({
      name: 'notifications',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: 100, // Keep last 100 completed jobs
        removeOnFail: 500, // Keep last 500 failed jobs
      },
    }),
    BullModule.registerQueue({
      name: 'price-comparison',
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    }),
    BullBoardModule.forFeature({
      name: 'notifications',
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: 'price-comparison',
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [QueuesController],
  providers: [NotificationsProcessor, NotificationsService, PriceComparisonProcessor],
  exports: [BullModule, NotificationsService],
})
export class QueuesModule {}
