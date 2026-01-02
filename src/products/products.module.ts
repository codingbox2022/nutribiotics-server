import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { Product, ProductSchema } from './schemas/product.schema';
import { Ingredient, IngredientSchema } from '../ingredients/schemas/ingredient.schema';
import { Brand, BrandSchema } from '../brands/schemas/brand.schema';
import { PricesModule } from '../prices/prices.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: Ingredient.name, schema: IngredientSchema },
      { name: Brand.name, schema: BrandSchema },
    ]),
    PricesModule,
  ],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
