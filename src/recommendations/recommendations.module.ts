import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Recommendation, RecommendationSchema } from './schemas/recommendation.schema';
import { RecommendationsService } from './recommendations.service';
import { RecommendationsController } from './recommendations.controller';
import { Price, PriceSchema } from '../prices/schemas/price.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { PriceHistory, PriceHistorySchema } from '../prices/schemas/price-history.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Recommendation.name, schema: RecommendationSchema },
      { name: Price.name, schema: PriceSchema },
      { name: Product.name, schema: ProductSchema },
      { name: PriceHistory.name, schema: PriceHistorySchema },
    ]),
  ],
  controllers: [RecommendationsController],
  providers: [RecommendationsService],
  exports: [RecommendationsService, MongooseModule],
})
export class RecommendationsModule {}
