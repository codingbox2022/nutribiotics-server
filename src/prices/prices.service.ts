import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Price, PriceDocument } from './schemas/price.schema';
import { CreatePriceDto } from './dto/create-price.dto';
import { UpdatePriceDto } from './dto/update-price.dto';
import { PaginatedResult } from '../common/interfaces/response.interface';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { Marketplace, MarketplaceDocument } from '../marketplaces/schemas/marketplace.schema';

interface FindAllFilters {
  productId?: string;
  marketplace?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class PricesService {
  constructor(
    @InjectModel(Price.name) private priceModel: Model<PriceDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(Marketplace.name) private marketplaceModel: Model<MarketplaceDocument>,
  ) {}

  async create(createPriceDto: CreatePriceDto): Promise<PriceDocument> {
    // Handle simple price update (from UI for Nutribiotics products)
    if (createPriceDto.value !== undefined) {
      return this.createSimplePrice(createPriceDto);
    }

    // Handle complex price creation (from scraper)
    const price = new this.priceModel(createPriceDto);
    return await price.save();
  }

  private async createSimplePrice(dto: CreatePriceDto): Promise<PriceDocument> {
    // Fetch product to get ingredient content
    const product = await this.productModel.findById(dto.productId).exec();
    if (!product) {
      throw new NotFoundException(`Product with ID ${dto.productId} not found`);
    }

    // Find or create a marketplace for Nutribiotics
    let marketplace = await this.marketplaceModel.findOne({ name: dto.marketplace || 'Nutribiotics Store' }).exec();
    if (!marketplace) {
      // Create a default marketplace for Nutribiotics if it doesn't exist
      marketplace = await this.marketplaceModel.create({
        name: dto.marketplace || 'Nutribiotics Store',
        country: 'Colombia',
        ivaRate: 0.19,
        baseUrl: 'https://nutribiotics.com',
        status: 'active',
      });
    }

    // Calculate prices with IVA
    const precioConIva = dto.value!;
    const precioSinIva = precioConIva / (1 + (marketplace.ivaRate || 0.19));

    // Get ingredient content from product
    const ingredientContent = product.ingredientContent instanceof Map
      ? Object.fromEntries(product.ingredientContent)
      : (product.ingredientContent || {});

    // Calculate price per ingredient content
    const pricePerIngredientContent: Record<string, number> = {};
    for (const [ingredientId, content] of Object.entries(ingredientContent)) {
      const numContent = Number(content);
      pricePerIngredientContent[ingredientId] = numContent > 0 ? precioSinIva / numContent : 0;
    }

    // Create price document
    const price = new this.priceModel({
      precioSinIva,
      precioConIva,
      ingredientContent,
      pricePerIngredientContent,
      marketplaceId: marketplace._id,
      productId: new Types.ObjectId(dto.productId),
      ingestionRunId: null, // Manual price updates don't have ingestion runs
    });

    return await price.save();
  }

  async findAll(filters: FindAllFilters): Promise<PaginatedResult<PriceDocument>> {
    const { page = 1, limit = 100, ...filterParams } = filters;
    const query: any = {};

    if (filterParams.productId) {
      // Explicitly convert string to ObjectId for query
      query.productId = new Types.ObjectId(filterParams.productId);
    }

    if (filterParams.marketplace) {
      query.marketplace = filterParams.marketplace;
    }

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.priceModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.priceModel.countDocuments(query).exec(),
    ]);

    return {
      data,
      meta: { page, limit, total },
    };
  }

  async findOne(id: string): Promise<PriceDocument> {
    const price = await this.priceModel.findById(id).exec();
    if (!price) {
      throw new NotFoundException(`Price with ID ${id} not found`);
    }
    return price;
  }

  async findByProduct(productId: string): Promise<PriceDocument[]> {
    return this.priceModel
      .find({ productId })
      .sort({ createdAt: -1 })
      .exec();
  }

  async update(id: string, updatePriceDto: UpdatePriceDto): Promise<PriceDocument> {
    const price = await this.priceModel
      .findByIdAndUpdate(id, updatePriceDto, { new: true })
      .exec();
    if (!price) {
      throw new NotFoundException(`Price with ID ${id} not found`);
    }
    return price;
  }

  async remove(id: string): Promise<void> {
    const result = await this.priceModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`Price with ID ${id} not found`);
    }
  }

  async getNutribioticsComparison(filters?: { search?: string }): Promise<any[]> {
    // Fetch all Nutribiotics products
    const query: any = { brand: /^NUTRIBIOTICS$/i };

    if (filters?.search) {
      query.name = { $regex: filters.search, $options: 'i' };
    }

    const nutribioticsProducts = await this.productModel
      .find(query)
      .exec();

    // Build comparison data for each product
    const comparisons = await Promise.all(
      nutribioticsProducts.map(async (product) => {
        // Get latest Nutribiotics price for this product
        const nutribioticsPrice = await this.priceModel
          .findOne({ productId: product._id })
          .sort({ createdAt: -1 })
          .exec();

        const currentPrice = nutribioticsPrice?.precioConIva || null;

        // Get all compared products (competitors) - directly query by comparedTo field
        const comparedProducts = await this.productModel
          .find({
            comparedTo: product._id,
            brand: { $not: { $regex: /^NUTRIBIOTICS$/i } }
          })
          .exec();

        // Collect all competitor prices from all marketplaces
        const allCompetitorPrices: number[] = [];
        const priceToMarketplaceMap = new Map<number, string>(); // Track which marketplace has which price
        let lastIngestionDate: Date | null = null;

        for (const comparedProduct of comparedProducts) {
          // Get all prices for this competitor product
          // Convert ObjectId to string for query - Mongoose auto-converts when querying
          const prices = await this.priceModel
            .find({ productId: comparedProduct._id.toString() })
            .sort({ createdAt: -1 })
            .exec();

          // Group by marketplace and take most recent price per marketplace
          const pricesByMarketplace = new Map<string, number>();
          const datesByMarketplace = new Map<string, Date>();

          for (const price of prices) {
            const mkId = price.marketplaceId.toString();
            if (!pricesByMarketplace.has(mkId)) {
              pricesByMarketplace.set(mkId, price.precioConIva);
              // Map this price to its marketplace ID
              priceToMarketplaceMap.set(price.precioConIva, mkId);

              const priceObj: any = price.toObject();
              const createdDate = priceObj.createdAt || new Date();
              datesByMarketplace.set(mkId, createdDate);

              // Track most recent ingestion date
              if (!lastIngestionDate || createdDate > lastIngestionDate) {
                lastIngestionDate = createdDate;
              }
            }
          }

          // Add all unique marketplace prices to the competitor prices array
          allCompetitorPrices.push(...pricesByMarketplace.values());
        }

        // Calculate min, max, avg from all competitor prices
        let minCompetitorPrice = 0;
        let maxCompetitorPrice = 0;
        let avgCompetitorPrice = 0;
        let minPriceMarketplace: string | null = null;
        let maxPriceMarketplace: string | null = null;
        let difference = 0;
        let differencePercent = 0;

        if (allCompetitorPrices.length > 0) {
          minCompetitorPrice = Math.min(...allCompetitorPrices);
          maxCompetitorPrice = Math.max(...allCompetitorPrices);
          avgCompetitorPrice = allCompetitorPrices.reduce((sum, price) => sum + price, 0) / allCompetitorPrices.length;

          // Get marketplace names for min and max prices
          const minMarketplaceId = priceToMarketplaceMap.get(minCompetitorPrice);
          const maxMarketplaceId = priceToMarketplaceMap.get(maxCompetitorPrice);

          if (minMarketplaceId) {
            const minMarketplace = await this.marketplaceModel.findById(minMarketplaceId).exec();
            minPriceMarketplace = minMarketplace?.name || null;
          }

          if (maxMarketplaceId) {
            const maxMarketplace = await this.marketplaceModel.findById(maxMarketplaceId).exec();
            maxPriceMarketplace = maxMarketplace?.name || null;
          }

          if (currentPrice !== null) {
            difference = currentPrice - avgCompetitorPrice;
            differencePercent = (difference / avgCompetitorPrice) * 100;
          }
        }

        return {
          id: product._id.toString(),
          productName: product.name,
          brand: product.brand,
          currentPrice,
          minCompetitorPrice,
          maxCompetitorPrice,
          avgCompetitorPrice,
          minPriceMarketplace,
          maxPriceMarketplace,
          difference,
          differencePercent,
          lastIngestionDate: lastIngestionDate ? lastIngestionDate.toISOString() : null,
        };
      })
    );

    return comparisons;
  }
}
