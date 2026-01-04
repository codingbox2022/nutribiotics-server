import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsService } from './notifications.service';
import { PriceComparisonProcessor } from './price-comparison.processor';
import { MarketplaceDiscoveryProcessor } from './marketplace-discovery.processor';
import { ProductDiscoveryProcessor } from './product-discovery.processor';
import { QueuesController } from './queues.controller';
import { IngestionRunsModule } from '../ingestion-runs/ingestion-runs.module';
import { PricesModule } from '../prices/prices.module';
import { MarketplacesModule } from '../marketplaces/marketplaces.module';
import { ProductsModule } from '../products/products.module';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import {
  Marketplace,
  MarketplaceSchema,
} from '../marketplaces/schemas/marketplace.schema';
import { Brand, BrandSchema } from '../brands/schemas/brand.schema';

@Module({
  imports: [
    IngestionRunsModule,
    PricesModule,
    MarketplacesModule,
    ProductsModule,
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: Marketplace.name, schema: MarketplaceSchema },
      { name: Brand.name, schema: BrandSchema },
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
    BullModule.registerQueue({
      name: 'marketplace-discovery',
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 3000,
        },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    }),
    BullModule.registerQueue({
      name: 'product-discovery',
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
    BullBoardModule.forFeature({
      name: 'marketplace-discovery',
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: 'product-discovery',
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [QueuesController],
  providers: [NotificationsProcessor, NotificationsService, PriceComparisonProcessor, MarketplaceDiscoveryProcessor, ProductDiscoveryProcessor],
  exports: [BullModule, NotificationsService],
})
export class QueuesModule {}
