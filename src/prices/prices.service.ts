import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Price, PriceDocument } from './schemas/price.schema';
import { PriceHistory, PriceHistoryDocument } from './schemas/price-history.schema';
import { CreatePriceDto } from './dto/create-price.dto';
import { UpdatePriceDto } from './dto/update-price.dto';
import { PaginatedResult } from '../common/interfaces/response.interface';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { Marketplace, MarketplaceDocument } from '../marketplaces/schemas/marketplace.schema';
import { Ingredient, IngredientDocument } from '../ingredients/schemas/ingredient.schema';
import { Brand, BrandDocument } from '../brands/schemas/brand.schema';
import { ApprovalStatus } from '../common/enums/approval-status.enum';

interface FindAllFilters {
  productId?: string;
  marketplace?: string;
  page?: number;
  limit?: number;
}

type BrandDisplay = {
  id: string;
  name: string | null;
};

@Injectable()
export class PricesService {
  constructor(
    @InjectModel(Price.name) private priceModel: Model<PriceDocument>,
    @InjectModel(PriceHistory.name) private priceHistoryModel: Model<PriceHistoryDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(Marketplace.name) private marketplaceModel: Model<MarketplaceDocument>,
    @InjectModel(Ingredient.name) private ingredientModel: Model<IngredientDocument>,
    @InjectModel(Brand.name) private brandModel: Model<BrandDocument>,
  ) {}

  private formatBrand(
    brand: Types.ObjectId | BrandDocument | string | null,
  ): BrandDisplay | null {
    if (!brand) {
      return null;
    }

    if (brand instanceof Types.ObjectId) {
      return { id: brand.toString(), name: null };
    }

    if (typeof brand === 'string') {
      return { id: brand, name: null };
    }

    return { id: brand._id.toString(), name: brand.name };
  }

  private async hydrateBrand(
    brand: Types.ObjectId | BrandDocument | string | null,
  ): Promise<BrandDisplay | null> {
    const formatted = this.formatBrand(brand);
    if (!formatted || formatted.name) {
      return formatted;
    }

    const brandDoc = await this.brandModel
      .findById(formatted.id)
      .select('name')
      .exec();

    if (!brandDoc) {
      return formatted;
    }

    return { id: brandDoc._id.toString(), name: brandDoc.name };
  }

  private async normalizeIngredientMap(
    ingredientContent: Map<string, number> | Record<string, number> | undefined,
  ): Promise<Record<string, number>> {
    const entries = ingredientContent instanceof Map
      ? Array.from(ingredientContent.entries())
      : Object.entries(ingredientContent || {});

    if (entries.length === 0) {
      return {};
    }

    const objectIdEntries = entries.filter(([ingredientId]) => Types.ObjectId.isValid(ingredientId));
    const ids = objectIdEntries.map(([ingredientId]) => ingredientId);

    const docs = ids.length > 0
      ? await this.ingredientModel
          .find({ _id: { $in: ids } })
          .select('name')
          .exec()
      : [];

    const nameMap = new Map(docs.map((doc) => [doc._id.toString(), doc.name]));

    return entries.reduce<Record<string, number>>((acc, [ingredientId, value]) => {
      const key = nameMap.get(ingredientId) || ingredientId;
      acc[key] = Number(value);
      return acc;
    }, {});
  }

  async create(createPriceDto: CreatePriceDto): Promise<PriceDocument> {
    // Handle simple price update (from UI for Nutribiotics products)
    if (createPriceDto.value !== undefined) {
      return this.createSimplePrice(createPriceDto);
    }

    // Handle complex price creation (from scraper)
    // Ensure proper ObjectId conversion
    const priceData = {
      ...createPriceDto,
      productId: new Types.ObjectId(createPriceDto.productId),
      marketplaceId: createPriceDto.marketplaceId ? new Types.ObjectId(createPriceDto.marketplaceId) : null,
      ingestionRunId: createPriceDto.ingestionRunId ? new Types.ObjectId(createPriceDto.ingestionRunId) : null,
    };

    const price = new this.priceModel(priceData);
    return await price.save();
  }

  private async createSimplePrice(dto: CreatePriceDto): Promise<PriceDocument> {
    // Fetch product to get ingredient content
    const product = await this.productModel.findById(dto.productId).exec();
    if (!product) {
      throw new NotFoundException(`Product with ID ${dto.productId} not found`);
    }

    // Calculate prices with IVA using default rate
    const IVA_RATE = 0.19;
    const precioConIva = dto.value!;
    const precioSinIva = precioConIva / (1 + IVA_RATE);

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
      marketplaceId: null,
      productId: new Types.ObjectId(dto.productId),
      ingestionRunId: null, // Manual price updates don't have ingestion runs
      priceConfidence: 1,
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
    const nutribioticsBrand = await this.brandModel
      .findOne({ name: { $regex: /^nutribiotics$/i } })
      .exec();

    if (!nutribioticsBrand) {
      return [];
    }

    // Fetch all Nutribiotics products
    const query: any = { brand: nutribioticsBrand._id };

    if (filters?.search) {
      query.name = { $regex: filters.search, $options: 'i' };
    }

    const nutribioticsProducts = await this.productModel
      .find(query)
      .populate({ path: 'brand', select: 'name status' })
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
            brand: { $ne: nutribioticsBrand._id }
          })
          .populate({ path: 'brand', select: 'name status' })
          .exec();

        // Collect all competitor prices from all marketplaces
        const allCompetitorPrices: number[] = [];
        const priceToMarketplaceMap = new Map<number, string>(); // Track which marketplace has which price
        let lastIngestionDate: Date | null = null;

        for (const comparedProduct of comparedProducts) {
          // Get all prices for this competitor product
          // Use ObjectId directly, not string
          const prices = await this.priceModel
            .find({ productId: comparedProduct._id })
            .sort({ createdAt: -1 })
            .exec();

          // Group by marketplace and take most recent price per marketplace
          const pricesByMarketplace = new Map<string, number>();
          const datesByMarketplace = new Map<string, Date>();

          for (const price of prices) {
            if (!price.marketplaceId) continue;

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
          brand: await this.hydrateBrand(product.brand as any),
          currentPrice,
          minCompetitorPrice,
          maxCompetitorPrice,
          avgCompetitorPrice,
          minPriceMarketplace,
          maxPriceMarketplace,
          difference,
          differencePercent,
          lastIngestionDate: lastIngestionDate ? lastIngestionDate.toISOString() : null,
          recommendation: nutribioticsPrice?.recommendation,
          recommendationReasoning: nutribioticsPrice?.recommendationReasoning,
          recommendedPrice: nutribioticsPrice?.recommendedPrice,
          recommendationStatus: nutribioticsPrice?.recommendationStatus,
        };
      })
    );

    return comparisons;
  }

  async getComparisonResultsByRunId(ingestionRunId: string, filters?: { search?: string }): Promise<any[]> {
    const nutribioticsBrand = await this.brandModel
      .findOne({ name: { $regex: /^nutribiotics$/i } })
      .exec();

    if (!nutribioticsBrand) {
      return [];
    }

    // Fetch all Nutribiotics products
    const query: any = { brand: nutribioticsBrand._id };

    if (filters?.search) {
      query.name = { $regex: filters.search, $options: 'i' };
    }

    const nutribioticsProducts = await this.productModel
      .find(query)
      .populate({ path: 'brand', select: 'name status' })
      .exec();

    // Convert ingestionRunId to ObjectId for querying
    const runObjectId = new Types.ObjectId(ingestionRunId);

    // Build comparison data for each product
    const comparisons = await Promise.all(
      nutribioticsProducts.map(async (product) => {
        // Get latest Nutribiotics price for this product
        // Nutribiotics prices are manually entered and have ingestionRunId: null
        const nutribioticsPrice = await this.priceModel
          .findOne({
            productId: product._id,
            ingestionRunId: null
          })
          .sort({ createdAt: -1 })
          .exec();

        const currentPrice = nutribioticsPrice?.precioConIva || null;

        // Get all compared products (competitors)
        const comparedProducts = await this.productModel
          .find({
            comparedTo: product._id,
            brand: { $ne: nutribioticsBrand._id }
          })
          .populate({ path: 'brand', select: 'name status' })
          .exec();

        // Collect all competitor prices from THIS run only
        const allCompetitorPrices: number[] = [];
        const priceToMarketplaceMap = new Map<number, string>();
        let lastIngestionDate: Date | null = null;

        for (const comparedProduct of comparedProducts) {
          // Get prices for this competitor product from THIS specific run
          const prices = await this.priceModel
            .find({
              productId: comparedProduct._id,
              ingestionRunId: runObjectId
            })
            .sort({ createdAt: -1 })
            .exec();

          // Group by marketplace and take most recent price per marketplace
          const pricesByMarketplace = new Map<string, number>();
          const datesByMarketplace = new Map<string, Date>();

          for (const price of prices) {
            if (!price.marketplaceId) continue;

            const mkId = price.marketplaceId.toString();
            if (!pricesByMarketplace.has(mkId)) {
              pricesByMarketplace.set(mkId, price.precioConIva);
              priceToMarketplaceMap.set(price.precioConIva, mkId);

              const priceObj: any = price.toObject();
              const createdDate = priceObj.createdAt || new Date();
              datesByMarketplace.set(mkId, createdDate);

              if (!lastIngestionDate || createdDate > lastIngestionDate) {
                lastIngestionDate = createdDate;
              }
            }
          }

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
          brand: await this.hydrateBrand(product.brand as any),
          currentPrice,
          minCompetitorPrice,
          maxCompetitorPrice,
          avgCompetitorPrice,
          minPriceMarketplace,
          maxPriceMarketplace,
          difference,
          differencePercent,
          lastIngestionDate: lastIngestionDate ? lastIngestionDate.toISOString() : null,
          recommendation: nutribioticsPrice?.recommendation,
          recommendationReasoning: nutribioticsPrice?.recommendationReasoning,
          recommendedPrice: nutribioticsPrice?.recommendedPrice,
          recommendationStatus: nutribioticsPrice?.recommendationStatus,
        };
      })
    );

    return comparisons;
  }

  async getProductPriceDetail(productId: string): Promise<any> {
    // Fetch the main Nutribiotics product
    const product = await this.productModel
      .findById(productId)
      .populate({ path: 'brand', select: 'name status' })
      .exec();
    if (!product) {
      throw new NotFoundException(`Product with ID ${productId} not found`);
    }

    // Get latest price for the main product
    const mainPrice = await this.priceModel
      .findOne({ productId: new Types.ObjectId(productId) })
      .sort({ createdAt: -1 })
      .exec();

    let mainMarketplaceName = 'Nutribiotics Store';
    if (mainPrice) {
      const marketplace = await this.marketplaceModel.findById(mainPrice.marketplaceId).exec();
      mainMarketplaceName = marketplace?.name || 'Nutribiotics Store';
    }

    // Get all ingredients to fetch units
    const allIngredients = await this.ingredientModel.find().exec();
    const ingredientUnitsMap = new Map<string, string>();
    allIngredients.forEach(ing => {
      ingredientUnitsMap.set(ing.name, ing.measurementUnit);
    });

    const IVA_RATE = 0.19;
    const normalizedIngredientContent = await this.normalizeIngredientMap(
      product.ingredientContent as any,
    );

    const normalizedPricePerIngredient = mainPrice
      ? await this.normalizeIngredientMap(mainPrice.pricePerIngredientContent as any)
      : {};

    const productData = {
      _id: mainPrice?._id?.toString(),
      id: product._id.toString(),
      name: product.name,
      brand: await this.hydrateBrand(product.brand as any),
      ingredientContent: normalizedIngredientContent,
      currentPrice: mainPrice?.precioConIva || null,
      currentPriceWithoutIva: mainPrice?.precioSinIva || null,
      currentPricePerIngredient: normalizedPricePerIngredient,
      marketplace: mainMarketplaceName,
      recommendation: mainPrice?.recommendation,
      recommendationReasoning: mainPrice?.recommendationReasoning,
      recommendedPrice: mainPrice?.recommendedPrice,
      recommendationStatus: mainPrice?.recommendationStatus,
      recommendationApprovedAt: mainPrice?.recommendationApprovedAt?.toISOString(),
      recommendationApprovedBy: mainPrice?.recommendationApprovedBy,
    };

    // Get all competitor products
    const productBrandId = product.brand instanceof Types.ObjectId
      ? product.brand
      : (product.brand as BrandDocument | undefined)?._id;

    const competitorFilter: any = { comparedTo: product._id };
    if (productBrandId) {
      competitorFilter.brand = { $ne: productBrandId };
    }

    const comparedProducts = await this.productModel
      .find(competitorFilter)
      .populate({ path: 'brand', select: 'name status' })
      .exec();

    // Build competitor data with marketplace breakdown
    const competitors = await Promise.all(
      comparedProducts.map(async (comp) => {
        const normalizedCompetitorIngredients = await this.normalizeIngredientMap(
          comp.ingredientContent as any,
        );

        // Get all prices for this competitor product
        const prices = await this.priceModel
          .find({ productId: comp._id })
          .sort({ createdAt: -1 })
          .exec();

        // Group by marketplace and take most recent per marketplace
        const marketplacePricesMap = new Map<string, any>();
        for (const price of prices) {
          if (!price.marketplaceId) continue;

          const mkId = price.marketplaceId.toString();
          if (!marketplacePricesMap.has(mkId)) {
            const marketplace = await this.marketplaceModel.findById(mkId).exec();
              const normalizedPricePerIngredient = await this.normalizeIngredientMap(
                price.pricePerIngredientContent as any,
              );
            marketplacePricesMap.set(mkId, {
              marketplaceName: marketplace?.name || 'Unknown',
              priceWithIva: price.precioConIva,
              priceWithoutIva: price.precioSinIva,
                pricePerIngredient: normalizedPricePerIngredient,
              extractedDate: (price as any).createdAt || new Date(),
            });
          }
        }

        return {
          id: comp._id.toString(),
          name: comp.name,
          brand: await this.hydrateBrand(comp.brand as any),
          ingredientContent: normalizedCompetitorIngredients,
          marketplacePrices: Array.from(marketplacePricesMap.values()),
        };
      })
    );

    // Get most recent ingestion date
    let lastIngestionDate: Date | null = null;
    for (const comp of competitors) {
      for (const mp of comp.marketplacePrices) {
        if (!lastIngestionDate || mp.extractedDate > lastIngestionDate) {
          lastIngestionDate = mp.extractedDate;
        }
      }
    }

    // Build ingredient units map from all unique ingredients
    const allIngredientNames = new Set<string>();
    Object.keys(productData.ingredientContent).forEach(name => allIngredientNames.add(name));
    competitors.forEach(comp => {
      Object.keys(comp.ingredientContent).forEach(name => allIngredientNames.add(name));
    });

    const ingredientUnits: Record<string, string> = {};
    allIngredientNames.forEach(name => {
      ingredientUnits[name] = ingredientUnitsMap.get(name) || 'unidad';
    });

    return {
      product: productData,
      competitors,
      ingredientUnits,
      lastIngestionDate: lastIngestionDate ? lastIngestionDate.toISOString() : null,
    };
  }

  async acceptRecommendation(priceId: string, user: any): Promise<any> {
    // 1. Find the price document with the recommendation
    const price = await this.priceModel.findById(priceId).exec();
    if (!price) {
      throw new NotFoundException(`Price with ID ${priceId} not found`);
    }

    // 2. Check if there's a recommended price
    if (!price.recommendedPrice) {
      throw new BadRequestException('No recommended price available');
    }

    // 3. Fetch product to recalculate price fields
    const product = await this.productModel.findById(price.productId).exec();
    if (!product) {
      throw new NotFoundException(`Product not found`);
    }

    // 4. Calculate prices with IVA
    const IVA_RATE = 0.19;
    const precioConIva = price.recommendedPrice;
    const precioSinIva = precioConIva / (1 + IVA_RATE);

    // 5. Get ingredient content from product
    const ingredientContent = product.ingredientContent instanceof Map
      ? Object.fromEntries(product.ingredientContent)
      : (product.ingredientContent || {});

    // 6. Calculate price per ingredient content
    const pricePerIngredientContent: Record<string, number> = {};
    for (const [ingredientId, content] of Object.entries(ingredientContent)) {
      const numContent = Number(content);
      pricePerIngredientContent[ingredientId] = numContent > 0 ? precioSinIva / numContent : 0;
    }

    // 7. Create price history record before updating
    const priceHistory = new this.priceHistoryModel({
      priceId: price._id,
      productId: price.productId,
      oldPrecioConIva: price.precioConIva,
      newPrecioConIva: precioConIva,
      oldPrecioSinIva: price.precioSinIva,
      newPrecioSinIva: precioSinIva,
      changeReason: 'recommendation_accepted',
      recommendation: price.recommendation,
      recommendedPrice: price.recommendedPrice,
      recommendationReasoning: price.recommendationReasoning,
      changedBy: user?.email || user?.id,
    });
    await priceHistory.save();

    // 8. Update the existing price document with the recommended price
    // This preserves the recommendation fields and updates the actual price
    const updatedPrice = await this.priceModel.findByIdAndUpdate(
      priceId,
      {
        precioConIva,
        precioSinIva,
        pricePerIngredientContent,
        recommendationStatus: ApprovalStatus.APPROVED,
        recommendationApprovedAt: new Date(),
        recommendationApprovedBy: user?.email || user?.id,
      },
      { new: true }
    ).exec();

    return {
      success: true,
      data: updatedPrice,
    };
  }

  async rejectRecommendation(priceId: string, user: any): Promise<any> {
    const price = await this.priceModel
      .findByIdAndUpdate(
        priceId,
        {
          recommendationStatus: ApprovalStatus.REJECTED,
          recommendationApprovedAt: new Date(),
          recommendationApprovedBy: user?.email || user?.id,
        },
        { new: true }
      )
      .exec();

    if (!price) {
      throw new NotFoundException(`Price with ID ${priceId} not found`);
    }

    return { success: true, data: price };
  }

  async bulkAcceptRecommendations(priceIds: string[], user: any): Promise<any> {
    const results = {
      successful: 0,
      failed: 0,
      errors: [] as { priceId: string; error: string }[],
    };

    for (const priceId of priceIds) {
      try {
        await this.acceptRecommendation(priceId, user);
        results.successful++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          priceId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return {
      success: results.failed === 0,
      data: results,
    };
  }
}
