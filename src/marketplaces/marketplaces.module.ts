import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MarketplacesService } from './marketplaces.service';
import { MarketplacesController } from './marketplaces.controller';
import { Marketplace, MarketplaceSchema } from './schemas/marketplace.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Marketplace.name, schema: MarketplaceSchema },
    ]),
  ],
  controllers: [MarketplacesController],
  providers: [MarketplacesService],
  exports: [MarketplacesService],
})
export class MarketplacesModule {}
