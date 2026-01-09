import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StatsService } from './stats.service';
import { StatsController } from './stats.controller';
import { Marketplace, MarketplaceSchema } from '../marketplaces/schemas/marketplace.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Marketplace.name, schema: MarketplaceSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
  ],
  providers: [StatsService],
  controllers: [StatsController],
})
export class StatsModule {}
