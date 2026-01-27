import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PricesService } from './prices.service';
import { PricesController } from './prices.controller';
import { Price, PriceSchema } from './schemas/price.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { Marketplace, MarketplaceSchema } from '../marketplaces/schemas/marketplace.schema';
import { Ingredient, IngredientSchema } from '../ingredients/schemas/ingredient.schema';
import { Brand, BrandSchema } from '../brands/schemas/brand.schema';
import { IngestionRun, IngestionRunSchema } from '../ingestion-runs/schemas/ingestion-run.schema';
import { RecommendationsModule } from '../recommendations/recommendations.module';

@Module({
  imports: [
    RecommendationsModule,
    MongooseModule.forFeature([
      { name: Price.name, schema: PriceSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Marketplace.name, schema: MarketplaceSchema },
      { name: Ingredient.name, schema: IngredientSchema },
      { name: Brand.name, schema: BrandSchema },
      { name: IngestionRun.name, schema: IngestionRunSchema },
    ]),
  ],
  controllers: [PricesController],
  providers: [PricesService],
  exports: [PricesService],
})
export class PricesModule {}
