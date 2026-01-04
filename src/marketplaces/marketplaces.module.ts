import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { MarketplacesService } from './marketplaces.service';
import { MarketplacesController } from './marketplaces.controller';
import { Marketplace, MarketplaceSchema } from './schemas/marketplace.schema';
import { ProductsModule } from '../products/products.module';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { Price, PriceSchema } from '../prices/schemas/price.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Marketplace.name, schema: MarketplaceSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Price.name, schema: PriceSchema },
    ]),
    ProductsModule,
    BullModule.registerQueue({
      name: 'marketplace-discovery',
    }),
  ],
  controllers: [MarketplacesController],
  providers: [MarketplacesService],
  exports: [MarketplacesService, MongooseModule],
})
export class MarketplacesModule {}
