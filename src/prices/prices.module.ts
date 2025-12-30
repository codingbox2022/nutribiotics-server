import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PricesService } from './prices.service';
import { PricesController } from './prices.controller';
import { Price, PriceSchema } from './schemas/price.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { Marketplace, MarketplaceSchema } from '../marketplaces/schemas/marketplace.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Price.name, schema: PriceSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Marketplace.name, schema: MarketplaceSchema },
    ]),
  ],
  controllers: [PricesController],
  providers: [PricesService],
  exports: [PricesService],
})
export class PricesModule {}
