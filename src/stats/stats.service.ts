import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Marketplace, MarketplaceDocument } from '../marketplaces/schemas/marketplace.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';

export interface LoginStats {
  totalMarketplaces: number;
  totalProducts: number;
}

@Injectable()
export class StatsService {
  constructor(
    @InjectModel(Marketplace.name)
    private marketplaceModel: Model<MarketplaceDocument>,
    @InjectModel(Product.name)
    private productModel: Model<ProductDocument>,
  ) {}

  async getLoginStats(): Promise<LoginStats> {
    const [totalMarketplaces, totalProducts] = await Promise.all([
      this.marketplaceModel.countDocuments({ status: 'active' }),
      this.productModel.countDocuments({ status: 'active' }),
    ]);

    return {
      totalMarketplaces,
      totalProducts,
    };
  }
}
