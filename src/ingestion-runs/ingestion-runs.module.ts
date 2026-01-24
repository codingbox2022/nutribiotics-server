import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IngestionRunsService } from './ingestion-runs.service';
import { IngestionRunsController } from './ingestion-runs.controller';
import {
  IngestionRun,
  IngestionRunSchema,
} from './schemas/ingestion-run.schema';
import { Price, PriceSchema } from '../prices/schemas/price.schema';
import { Recommendation, RecommendationSchema } from '../recommendations/schemas/recommendation.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IngestionRun.name, schema: IngestionRunSchema },
      { name: Price.name, schema: PriceSchema },
      { name: Recommendation.name, schema: RecommendationSchema },
    ]),
  ],
  controllers: [IngestionRunsController],
  providers: [IngestionRunsService],
  exports: [IngestionRunsService],
})
export class IngestionRunsModule {}
