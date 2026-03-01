import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as ExcelJS from 'exceljs';
import { Price, PriceDocument } from './schemas/price.schema';
import { CreatePriceDto } from './dto/create-price.dto';
import { UpdatePriceDto } from './dto/update-price.dto';
import { PaginatedResult } from '../common/interfaces/response.interface';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { Marketplace, MarketplaceDocument } from '../marketplaces/schemas/marketplace.schema';
import { Ingredient, IngredientDocument } from '../ingredients/schemas/ingredient.schema';
import { Brand, BrandDocument } from '../brands/schemas/brand.schema';
import { IngestionRun, IngestionRunDocument } from '../ingestion-runs/schemas/ingestion-run.schema';
import { RecommendationsService } from '../recommendations/recommendations.service';

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
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(Marketplace.name) private marketplaceModel: Model<MarketplaceDocument>,
    @InjectModel(Ingredient.name) private ingredientModel: Model<IngredientDocument>,
    @InjectModel(Brand.name) private brandModel: Model<BrandDocument>,
    @InjectModel(IngestionRun.name) private ingestionRunModel: Model<IngestionRunDocument>,
    private recommendationsService: RecommendationsService,
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

  async getLatestPricesForProducts(
    productIds: Types.ObjectId[],
  ): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();

    const results = await this.priceModel.aggregate([
      { $match: { productId: { $in: productIds } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$productId', precioConIva: { $first: '$precioConIva' } } },
    ]);

    return new Map(
      results.map((r: any) => [r._id.toString(), r.precioConIva]),
    );
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
      .lean()
      .exec() as unknown as PriceDocument[];
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
      .findOne({ name: { $regex: /^nutrabiotics$/i } })
      .select('_id name')
      .lean()
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
      .lean()
      .exec();

    if (nutribioticsProducts.length === 0) {
      return [];
    }

    const nutribioticsProductIds = nutribioticsProducts.map(p => p._id);

    // BATCH QUERY 1: Get all Nutribiotics prices at once
    const nutribioticsPrices = await this.priceModel
      .find({
        productId: { $in: nutribioticsProductIds },
        marketplaceId: null,
      })
      .select('productId precioConIva createdAt')
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    // Create a map of product ID to its latest price
    const nutribioticsPriceMap = new Map<string, any>();
    for (const price of nutribioticsPrices) {
      const productId = price.productId.toString();
      if (!nutribioticsPriceMap.has(productId)) {
        nutribioticsPriceMap.set(productId, price);
      }
    }

    // BATCH QUERY 2: Get all recommendations at once
    const allRecommendations = await Promise.all(
      nutribioticsProducts.map((product) =>
        this.recommendationsService.getLatestRecommendationForProduct(
          product._id.toString(),
        )
      )
    );
    const recommendationMap = new Map<string, any>();
    nutribioticsProducts.forEach((product, index) => {
      if (allRecommendations[index]) {
        recommendationMap.set(product._id.toString(), allRecommendations[index]);
      }
    });

    // BATCH QUERY 3: Get all compared products (competitors) at once
    const allComparedProducts = await this.productModel
      .find({
        comparedTo: { $in: nutribioticsProductIds },
        brand: { $ne: nutribioticsBrand._id }
      })
      .select('_id comparedTo brand')
      .lean()
      .exec();

    // Group competitor products by the Nutribiotics product they're compared to
    const comparedProductsByParent = new Map<string, any[]>();
    for (const comparedProduct of allComparedProducts) {
      const parentId = comparedProduct.comparedTo?.toString();
      if (parentId) {
        if (!comparedProductsByParent.has(parentId)) {
          comparedProductsByParent.set(parentId, []);
        }
        comparedProductsByParent.get(parentId)!.push(comparedProduct);
      }
    }

    // BATCH QUERY 4: Get all competitor prices at once
    const allCompetitorProductIds = allComparedProducts.map(p => p._id);
    const allCompetitorPricesData = allCompetitorProductIds.length > 0
      ? await this.priceModel
          .find({ productId: { $in: allCompetitorProductIds } })
          .select('productId marketplaceId precioConIva createdAt')
          .sort({ createdAt: -1 })
          .lean()
          .exec()
      : [];

    // Group competitor prices by product ID
    const competitorPricesByProduct = new Map<string, any[]>();
    for (const price of allCompetitorPricesData) {
      const productId = price.productId.toString();
      if (!competitorPricesByProduct.has(productId)) {
        competitorPricesByProduct.set(productId, []);
      }
      competitorPricesByProduct.get(productId)!.push(price);
    }

    // BATCH QUERY 5: Get all unique marketplace IDs and load them at once
    const allMarketplaceIds = new Set<string>();
    for (const price of allCompetitorPricesData) {
      if (price.marketplaceId) {
        allMarketplaceIds.add(price.marketplaceId.toString());
      }
    }

    const marketplaces = allMarketplaceIds.size > 0
      ? await this.marketplaceModel
          .find({ _id: { $in: Array.from(allMarketplaceIds) } })
          .select('name')
          .lean()
          .exec()
      : [];

    const marketplaceMap = new Map<string, string>();
    for (const marketplace of marketplaces) {
      marketplaceMap.set(marketplace._id.toString(), marketplace.name);
    }

    // BATCH QUERY 6: Get all unique brand IDs and load them at once
    const allBrandIds = new Set<string>();
    allBrandIds.add(nutribioticsBrand._id.toString());
    for (const product of nutribioticsProducts) {
      if (product.brand) {
        allBrandIds.add(product.brand.toString());
      }
    }

    const brands = await this.brandModel
      .find({ _id: { $in: Array.from(allBrandIds) } })
      .select('name status')
      .lean()
      .exec();

    const brandMap = new Map<string, any>();
    for (const brand of brands) {
      brandMap.set(brand._id.toString(), {
        id: brand._id.toString(),
        name: brand.name,
        status: brand.status
      });
    }

    // Build comparison data for each product (now using in-memory lookups)
    const comparisons = nutribioticsProducts.map((product) => {
      const productId = product._id.toString();

      // Get Nutribiotics price from map
      const nutribioticsPrice = nutribioticsPriceMap.get(productId);
      const latestRecommendation = recommendationMap.get(productId);
      const currentPrice = latestRecommendation?.currentPrice ?? nutribioticsPrice?.precioConIva ?? null;

      // Get compared products from map
      const comparedProducts = comparedProductsByParent.get(productId) || [];

      // Collect all competitor prices
      const allCompetitorPrices: number[] = [];
      const priceToMarketplaceMap = new Map<number, string>();
      let lastIngestionDate: Date | null = null;

      for (const comparedProduct of comparedProducts) {
        const comparedProductId = comparedProduct._id.toString();
        const prices = competitorPricesByProduct.get(comparedProductId) || [];

        // Group by marketplace and take most recent price per marketplace
        const pricesByMarketplace = new Map<string, number>();

        for (const price of prices) {
          if (!price.marketplaceId) continue;

          const mkId = price.marketplaceId.toString();
          if (!pricesByMarketplace.has(mkId)) {
            pricesByMarketplace.set(mkId, price.precioConIva);
            priceToMarketplaceMap.set(price.precioConIva, mkId);

            const createdDate = price.createdAt || new Date();
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

        // Get marketplace names for min and max prices from map
        const minMarketplaceId = priceToMarketplaceMap.get(minCompetitorPrice);
        const maxMarketplaceId = priceToMarketplaceMap.get(maxCompetitorPrice);

        if (minMarketplaceId) {
          minPriceMarketplace = marketplaceMap.get(minMarketplaceId) || null;
        }

        if (maxMarketplaceId) {
          maxPriceMarketplace = marketplaceMap.get(maxMarketplaceId) || null;
        }

        if (currentPrice !== null) {
          difference = currentPrice - avgCompetitorPrice;
          differencePercent = (difference / avgCompetitorPrice) * 100;
        }
      }

      // Get brand from map
      const brandId = product.brand?.toString();
      const brand = brandId ? brandMap.get(brandId) : null;

      return {
        id: productId,
        productName: product.name,
        brand: brand || null,
        currentPrice,
        minCompetitorPrice,
        maxCompetitorPrice,
        avgCompetitorPrice,
        minPriceMarketplace,
        maxPriceMarketplace,
        difference,
        differencePercent,
        lastIngestionDate: lastIngestionDate ? lastIngestionDate.toISOString() : null,
        recommendationId: latestRecommendation?._id?.toString(),
        recommendation: latestRecommendation?.recommendation,
        recommendationReasoning: latestRecommendation?.recommendationReasoning,
        recommendedPrice: latestRecommendation?.recommendedPrice,
        recommendationStatus: latestRecommendation?.recommendationStatus,
      };
    });

    return comparisons;
  }

  async getComparisonResultsByRunId(
    ingestionRunId: string,
    filters?: { search?: string },
  ): Promise<any[]> {
    const nutribioticsBrand = await this.brandModel
      .findOne({ name: { $regex: /^nutrabiotics$/i } })
      .lean()
      .exec();

    if (!nutribioticsBrand) {
      return [];
    }

    // Check if this run was for a single product
    const ingestionRun = await this.ingestionRunModel
      .findById(ingestionRunId)
      .select('productId')
      .lean()
      .exec();

    // Fetch Nutribiotics products — scoped to the run's target product if applicable
    const query: any = { brand: nutribioticsBrand._id };

    if (ingestionRun?.productId) {
      query._id = ingestionRun.productId;
    }

    if (filters?.search) {
      query.name = { $regex: filters.search, $options: 'i' };
    }

    const nutribioticsProducts = await this.productModel
      .find(query)
      .lean()
      .exec();

    if (nutribioticsProducts.length === 0) {
      return [];
    }

    // Convert ingestionRunId to ObjectId for querying
    const runObjectId = new Types.ObjectId(ingestionRunId);
    const nutribioticsProductIds = nutribioticsProducts.map((p) => p._id);

    // EXECUTE INDEPENDENT QUERIES IN PARALLEL
    const [
      nutribioticsPrices,
      allRecommendationsList,
      allComparedProducts,
    ] = await Promise.all([
      // QUERY 1: Nutribiotics prices
      this.priceModel
        .find({
          productId: { $in: nutribioticsProductIds },
          marketplaceId: null,
        })
        .sort({ createdAt: -1 })
        .lean()
        .exec(),

      // QUERY 2: Recommendations (Batch fetch)
      this.recommendationsService.findByRunIdAndProductIds(
        ingestionRunId,
        nutribioticsProductIds.map((id) => id.toString()),
      ),

      // QUERY 3: Compared products (Competitors)
      this.productModel
        .find({
          comparedTo: { $in: nutribioticsProductIds },
          brand: { $ne: nutribioticsBrand._id },
        })
        .lean()
        .exec(),
    ]);

    // Process Nutribiotics Prices
    const nutribioticsPriceMap = new Map<string, any>();
    for (const price of nutribioticsPrices) {
      const productId = price.productId.toString();
      if (!nutribioticsPriceMap.has(productId)) {
        nutribioticsPriceMap.set(productId, price);
      }
    }

    // Process Recommendations
    const recommendationMap = new Map<string, any>();
    for (const rec of allRecommendationsList) {
      recommendationMap.set(rec.productId.toString(), rec);
    }

    // Process Compared Products
    const comparedProductsByParent = new Map<string, any[]>();
    for (const comparedProduct of allComparedProducts) {
      const parentId = comparedProduct.comparedTo?.toString();
      if (parentId) {
        if (!comparedProductsByParent.has(parentId)) {
          comparedProductsByParent.set(parentId, []);
        }
        comparedProductsByParent.get(parentId)!.push(comparedProduct);
      }
    }

    // QUERY 4: Competitor prices (dependent on compared products)
    const allCompetitorProductIds = allComparedProducts.map((p) => p._id);
    const allCompetitorPricesData =
      allCompetitorProductIds.length > 0
        ? await this.priceModel
            .find({
              productId: { $in: allCompetitorProductIds },
              ingestionRunId: runObjectId,
            })
            .sort({ createdAt: -1 })
            .lean()
            .exec()
        : [];

    // Group competitor prices by product ID
    const competitorPricesByProduct = new Map<string, any[]>();
    for (const price of allCompetitorPricesData) {
      const productId = price.productId.toString();
      if (!competitorPricesByProduct.has(productId)) {
        competitorPricesByProduct.set(productId, []);
      }
      competitorPricesByProduct.get(productId)!.push(price);
    }

    // Prepare sets for Marketplaces and Brands
    const allMarketplaceIds = new Set<string>();
    for (const price of allCompetitorPricesData) {
      if (price.marketplaceId) {
        allMarketplaceIds.add(price.marketplaceId.toString());
      }
    }

    const allBrandIds = new Set<string>();
    allBrandIds.add(nutribioticsBrand._id.toString());
    for (const product of allComparedProducts) {
      if (product.brand) {
        allBrandIds.add(product.brand.toString());
      }
    }

    // QUERY 5 & 6: Fetch Marketplaces and Brands in PARALLEL
    const [marketplaces, brands] = await Promise.all([
      allMarketplaceIds.size > 0
        ? this.marketplaceModel
            .find({ _id: { $in: Array.from(allMarketplaceIds) } })
            .select('name')
            .lean()
            .exec()
        : [],
      this.brandModel
        .find({ _id: { $in: Array.from(allBrandIds) } })
        .select('name status')
        .lean()
        .exec(),
    ]);

    const marketplaceMap = new Map<string, string>();
    for (const marketplace of marketplaces) {
      marketplaceMap.set(marketplace._id.toString(), marketplace.name);
    }

    const brandMap = new Map<string, any>();
    for (const brand of brands) {
      brandMap.set(brand._id.toString(), {
        id: brand._id.toString(),
        name: brand.name,
        status: brand.status,
      });
    }

    // Build comparison data
    const comparisons = nutribioticsProducts.map((product) => {
      const productId = product._id.toString();

      // Get Nutribiotics price
      const nutribioticsPrice = nutribioticsPriceMap.get(productId);
      const latestRecommendation = recommendationMap.get(productId);
      const currentPrice =
        latestRecommendation?.currentPrice ??
        nutribioticsPrice?.precioConIva ??
        null;

      // Get compared products
      const comparedProducts = comparedProductsByParent.get(productId) || [];

      // Collect all competitor prices from THIS run only
      const allCompetitorPrices: number[] = [];
      const priceToMarketplaceMap = new Map<number, string>();
      let lastIngestionDate: Date | null = null;

      for (const comparedProduct of comparedProducts) {
        const comparedProductId = comparedProduct._id.toString();
        const prices = competitorPricesByProduct.get(comparedProductId) || [];

        // Group by marketplace and take most recent price per marketplace
        const pricesByMarketplace = new Map<string, number>();

        for (const price of prices) {
          if (!price.marketplaceId) continue;

          const mkId = price.marketplaceId.toString();
          if (!pricesByMarketplace.has(mkId)) {
            pricesByMarketplace.set(mkId, price.precioConIva);
            priceToMarketplaceMap.set(price.precioConIva, mkId);

            const createdDate = price.createdAt || new Date();
            if (!lastIngestionDate || createdDate > lastIngestionDate) {
              lastIngestionDate = createdDate;
            }
          }
        }

        allCompetitorPrices.push(...pricesByMarketplace.values());
      }

      // Calculate stats
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
        avgCompetitorPrice =
          allCompetitorPrices.reduce((sum, price) => sum + price, 0) /
          allCompetitorPrices.length;

        const minMarketplaceId = priceToMarketplaceMap.get(minCompetitorPrice);
        const maxMarketplaceId = priceToMarketplaceMap.get(maxCompetitorPrice);

        if (minMarketplaceId) {
          minPriceMarketplace = marketplaceMap.get(minMarketplaceId) || null;
        }

        if (maxMarketplaceId) {
          maxPriceMarketplace = marketplaceMap.get(maxMarketplaceId) || null;
        }

        if (currentPrice !== null) {
          difference = currentPrice - avgCompetitorPrice;
          differencePercent = (difference / avgCompetitorPrice) * 100;
        }
      }

      const brandId = product.brand?.toString();
      const brand = brandId ? brandMap.get(brandId) : null;

      return {
        id: productId,
        productName: product.name,
        brand: brand || null,
        currentPrice,
        minCompetitorPrice,
        maxCompetitorPrice,
        avgCompetitorPrice,
        minPriceMarketplace,
        maxPriceMarketplace,
        difference,
        differencePercent,
        lastIngestionDate: lastIngestionDate
          ? lastIngestionDate.toISOString()
          : null,
        recommendationId: latestRecommendation?._id?.toString(),
        recommendation: latestRecommendation?.recommendation,
        recommendationReasoning: latestRecommendation?.recommendationReasoning,
        recommendedPrice: latestRecommendation?.recommendedPrice,
        recommendationStatus: latestRecommendation?.recommendationStatus,
      };
    });

    return comparisons;
  }

  async getProductPriceDetail(productId: string, ingestionRunId?: string): Promise<any> {
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
      .lean()
      .exec();

    let mainMarketplaceName = 'Nutrabiotics Store';
    if (mainPrice?.marketplaceId) {
      const marketplace = await this.marketplaceModel
        .findById(mainPrice.marketplaceId)
        .select('name')
        .lean()
        .exec();
      mainMarketplaceName = marketplace?.name || 'Nutrabiotics Store';
    }

    // Get all ingredients to fetch units (with projection for only needed fields)
    const allIngredients = await this.ingredientModel
      .find()
      .select('name measurementUnit')
      .lean()
      .exec();
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

    const latestRecommendation = await this.recommendationsService.getLatestRecommendationForProduct(
      product._id.toString(),
      ingestionRunId,
    );

    const recommendationPrice = latestRecommendation?.currentPrice ?? null;
    const displayCurrentPrice = recommendationPrice ?? mainPrice?.precioConIva ?? null;
    const displayCurrentPriceWithoutIva = displayCurrentPrice !== null
      ? displayCurrentPrice / (1 + IVA_RATE)
      : null;

    const productData = {
      _id: mainPrice?._id?.toString(),
      id: product._id.toString(),
      name: product.name,
      brand: await this.hydrateBrand(product.brand as any),
      ingredientContent: normalizedIngredientContent,
      currentPrice: displayCurrentPrice,
      currentPriceWithoutIva: displayCurrentPriceWithoutIva,
      currentPricePerIngredient: normalizedPricePerIngredient,
      marketplace: mainMarketplaceName,
      recommendationId: latestRecommendation?._id?.toString(),
      recommendation: latestRecommendation?.recommendation,
      recommendationReasoning: latestRecommendation?.recommendationReasoning,
      recommendedPrice: latestRecommendation?.recommendedPrice,
      recommendationStatus: latestRecommendation?.recommendationStatus,
      recommendationApprovedAt: latestRecommendation?.recommendationApprovedAt?.toISOString(),
      recommendationApprovedBy: latestRecommendation?.recommendationApprovedBy,
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
      .lean()
      .exec();

    // BATCH: Get all competitor prices at once
    const competitorProductIds = comparedProducts.map(p => p._id);
    const competitorPriceFilter: any = { productId: { $in: competitorProductIds } };
    if (ingestionRunId) {
      competitorPriceFilter.ingestionRunId = new Types.ObjectId(ingestionRunId);
    }
    const allCompetitorPrices = competitorProductIds.length > 0
      ? await this.priceModel
          .find(competitorPriceFilter)
          .sort({ createdAt: -1 })
          .lean()
          .exec()
      : [];

    // Group prices by product ID
    const pricesByProductId = new Map<string, any[]>();
    for (const price of allCompetitorPrices) {
      const prodId = price.productId.toString();
      if (!pricesByProductId.has(prodId)) {
        pricesByProductId.set(prodId, []);
      }
      pricesByProductId.get(prodId)!.push(price);
    }

    // BATCH: Get all unique marketplace IDs and load them at once
    const allMarketplaceIds = new Set<string>();
    for (const price of allCompetitorPrices) {
      if (price.marketplaceId) {
        allMarketplaceIds.add(price.marketplaceId.toString());
      }
    }

    const marketplaces = allMarketplaceIds.size > 0
      ? await this.marketplaceModel
          .find({ _id: { $in: Array.from(allMarketplaceIds) } })
          .select('name')
          .lean()
          .exec()
      : [];

    const marketplaceMap = new Map<string, string>();
    for (const marketplace of marketplaces) {
      marketplaceMap.set(marketplace._id.toString(), marketplace.name);
    }

    // Build competitor data with marketplace breakdown (now using in-memory lookups)
    const competitors = await Promise.all(
      comparedProducts.map(async (comp) => {
        const normalizedCompetitorIngredients = await this.normalizeIngredientMap(
          comp.ingredientContent as any,
        );

        // Get prices from the pre-loaded map
        const prices = pricesByProductId.get(comp._id.toString()) || [];

        // Group by marketplace and take most recent per marketplace
        const marketplacePricesMap = new Map<string, any>();
        for (const price of prices) {
          if (!price.marketplaceId) continue;

          const mkId = price.marketplaceId.toString();
          if (!marketplacePricesMap.has(mkId)) {
            const normalizedPricePerIngredient = await this.normalizeIngredientMap(
              price.pricePerIngredientContent as any,
            );
            marketplacePricesMap.set(mkId, {
              marketplaceName: marketplaceMap.get(mkId) || 'Unknown',
              priceWithIva: price.precioConIva,
              priceWithoutIva: price.precioSinIva,
              pricePerIngredient: normalizedPricePerIngredient,
              extractedDate: price.createdAt || new Date(),
            });
          }
        }

        return {
          id: comp._id.toString(),
          name: comp.name,
          brand: this.formatBrand(comp.brand as any),
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

  private getBrandDisplayName(brand: { id: string; name: string | null } | null): string {
    if (!brand) return 'Sin marca';
    return brand.name ?? brand.id ?? 'Sin marca';
  }

  private sanitizeSheetName(name: string, used: Set<string>): string {
    const invalid = /[\\/*?:\[\]]/g;
    let base = name.replace(invalid, '').trim().slice(0, 31) || 'Hoja';
    let candidate = base;
    let n = 1;
    while (used.has(candidate)) {
      const suffix = ` (${n})`;
      candidate = (base.slice(0, 31 - suffix.length) || base).trim() + suffix;
      n++;
    }
    used.add(candidate);
    return candidate;
  }

  private formatCurrencyExcel(value: number | null): string {
    if (value === null || value === undefined) return '';
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  }

  private formatDateExcel(isoDate: string | null): string {
    if (!isoDate) return '';
    try {
      return new Intl.DateTimeFormat('es-CO', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).format(new Date(isoDate));
    } catch {
      return isoDate;
    }
  }

  private recommendationLabel(recommendation: string | undefined): string {
    if (!recommendation) return '';
    const map: Record<string, string> = {
      raise: 'Subir',
      lower: 'Bajar',
      keep: 'Mantener',
    };
    return map[recommendation] ?? recommendation;
  }

  private recommendationStatusLabel(status: string | undefined): string {
    if (!status) return '';
    const map: Record<string, string> = {
      not_approved: 'Pendiente',
      approved: 'Aprobado',
      rejected: 'Rechazado',
    };
    return map[status] ?? status;
  }

  /** Project primary violet (HSL 272 54% 20%) as ARGB for Excel header fill; white text. */
  private static readonly EXCEL_HEADER_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF2E1A4A' } };
  private static readonly EXCEL_HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };

  private setHeaderRowStyle(sheet: ExcelJS.Worksheet, rowNumber: number): void {
    const row = sheet.getRow(rowNumber);
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.fill = PricesService.EXCEL_HEADER_FILL;
      cell.font = PricesService.EXCEL_HEADER_FONT;
    });
  }

  private setColumnWidthsFromContent(sheet: ExcelJS.Worksheet): void {
    const maxLen: Record<number, number> = {};
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const len = String(cell.value ?? '').length;
        maxLen[colNumber] = Math.max(maxLen[colNumber] ?? 0, len);
      });
    });
    for (const colNumber of Object.keys(maxLen)) {
      const col = Number(colNumber);
      const w = maxLen[col];
      sheet.getColumn(col).width = Math.min(80, Math.max(10, w + 2));
    }
  }

  async exportComparisonResultsToExcel(
    ingestionRunId: string,
    onProgress?: (percent: number) => void | Promise<void>,
  ): Promise<Buffer> {
    const report = async (p: number) => {
      if (onProgress) await Promise.resolve(onProgress(p));
    };

    const comparisonResults = await this.getComparisonResultsByRunId(ingestionRunId);
    if (comparisonResults.length === 0) {
      throw new NotFoundException('No hay resultados de comparación para este run');
    }

    const workbook = new ExcelJS.Workbook();
    const resumenSheet = workbook.addWorksheet('Resumen', { views: [{ state: 'frozen', ySplit: 1 }] });

    // Master sheet headers
    const masterHeaders = [
      'Producto',
      'Marca',
      'Precio Actual',
      'Mín. Competencia',
      'Prom. Competencia',
      'Máx. Competencia',
      'Mín. Mercado',
      'Máx. Mercado',
      'Diferencia',
      'Diferencia %',
      'Recomendación',
      'Precio Recomendado',
      'Estado',
      'Justificación',
      'Última Ingesta',
    ];
    resumenSheet.addRow(masterHeaders);
    this.setHeaderRowStyle(resumenSheet, 1);

    for (const row of comparisonResults) {
      const brandName = this.getBrandDisplayName(row.brand);
      resumenSheet.addRow([
        row.productName,
        brandName,
        row.currentPrice,
        row.minCompetitorPrice || '',
        row.avgCompetitorPrice || '',
        row.maxCompetitorPrice || '',
        row.minPriceMarketplace ?? '',
        row.maxPriceMarketplace ?? '',
        row.difference ?? '',
        row.differencePercent != null ? `${row.differencePercent.toFixed(1)}%` : '',
        this.recommendationLabel(row.recommendation),
        row.recommendedPrice ?? '',
        this.recommendationStatusLabel(row.recommendationStatus),
        row.recommendationReasoning ?? '',
        this.formatDateExcel(row.lastIngestionDate),
      ]);
    }
    this.setColumnWidthsFromContent(resumenSheet);

    // Build global "all products vs marketplaces" data and collect details for per-product sheets
    const productsMap = new Map<string, { name: string; brand: string }>();
    const dataSinIva = new Map<string, Map<string, number>>();
    const dataConIva = new Map<string, Map<string, number>>();
    const allMarketplacesSet = new Set<string>();
    const nutrabioticsProductIds = new Set<string>();
    const detailsForSheets: Array<{ summary: { productName: string }; detail: { product: any; competitors: any[]; ingredientUnits?: Record<string, string> } }> = [];
    const totalProducts = comparisonResults.length;

    await report(5);

    for (let i = 0; i < comparisonResults.length; i++) {
      const summary = comparisonResults[i];
      let detail: { product: any; competitors: any[]; ingredientUnits?: Record<string, string> };
      try {
        detail = await this.getProductPriceDetail(summary.id, ingestionRunId);
      } catch {
        await report(totalProducts > 0 ? 5 + Math.round(((i + 1) / totalProducts) * 90) : 5);
        continue;
      }

      const product = detail.product;
      await report(totalProducts > 0 ? 5 + Math.round(((i + 1) / totalProducts) * 90) : 5);
      const productId = product.id;
      const brandName = this.getBrandDisplayName(product.brand);

      nutrabioticsProductIds.add(productId);
      productsMap.set(productId, { name: product.name, brand: brandName });
      if (!dataSinIva.has(productId)) {
        dataSinIva.set(productId, new Map());
        dataConIva.set(productId, new Map());
      }
      const mainMarketplace = product.marketplace ?? '—';
      allMarketplacesSet.add(mainMarketplace);
      if (product.currentPriceWithoutIva != null) dataSinIva.get(productId)!.set(mainMarketplace, product.currentPriceWithoutIva);
      if (product.currentPrice != null) dataConIva.get(productId)!.set(mainMarketplace, product.currentPrice);

      for (const comp of detail.competitors) {
        const compId = comp.id;
        const compBrand = this.getBrandDisplayName(comp.brand);
        productsMap.set(compId, { name: comp.name, brand: compBrand });
        if (!dataSinIva.has(compId)) {
          dataSinIva.set(compId, new Map());
          dataConIva.set(compId, new Map());
        }
        for (const mp of comp.marketplacePrices ?? []) {
          const mkName = mp.marketplaceName ?? '—';
          allMarketplacesSet.add(mkName);
          dataSinIva.get(compId)!.set(mkName, mp.priceWithoutIva);
          dataConIva.get(compId)!.set(mkName, mp.priceWithIva);
        }
      }

      detailsForSheets.push({ summary, detail });
    }

    const NUTRABIOTICS_STORE = 'Nutrabiotics Store';
    const allMarketplaces = Array.from(allMarketplacesSet)
      .filter((m) => m !== NUTRABIOTICS_STORE)
      .sort();
    const competitorProductIds = Array.from(productsMap.keys()).filter((id) => !nutrabioticsProductIds.has(id));

    // Global sheet: Precios sin IVA (competitors x marketplaces) — second sheet
    const sheetSinIva = workbook.addWorksheet('Precios sin IVA', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheetSinIva.addRow(['Producto', 'Marca', ...allMarketplaces]);
    this.setHeaderRowStyle(sheetSinIva, 1);
    for (const productId of competitorProductIds) {
      const { name, brand } = productsMap.get(productId)!;
      const prices = dataSinIva.get(productId)!;
      const row = [name, brand, ...allMarketplaces.map((m) => this.formatCurrencyExcel(prices.get(m) ?? null))];
      sheetSinIva.addRow(row);
    }
    this.setColumnWidthsFromContent(sheetSinIva);

    // Global sheet: Precios con IVA (competitors x marketplaces) — third sheet
    const sheetConIva = workbook.addWorksheet('Precios con IVA', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheetConIva.addRow(['Producto', 'Marca', ...allMarketplaces]);
    this.setHeaderRowStyle(sheetConIva, 1);
    for (const productId of competitorProductIds) {
      const { name, brand } = productsMap.get(productId)!;
      const prices = dataConIva.get(productId)!;
      const row = [name, brand, ...allMarketplaces.map((m) => this.formatCurrencyExcel(prices.get(m) ?? null))];
      sheetConIva.addRow(row);
    }
    this.setColumnWidthsFromContent(sheetConIva);

    // Per-product detail sheets (fourth onwards): comparison table — competitors only
    const usedSheetNames = new Set<string>(['Resumen', 'Precios sin IVA', 'Precios con IVA']);
    for (let d = 0; d < detailsForSheets.length; d++) {
      const { summary, detail } = detailsForSheets[d];
      const product = detail.product;

      const sheetName = this.sanitizeSheetName(summary.productName, usedSheetNames);
      const sheet = workbook.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });

      const allProducts: Array<{
        name: string;
        brand: string;
        priceWithIva: number;
        priceWithoutIva: number;
        pricePerIngredient: Record<string, number>;
      }> = [];

      for (const comp of detail.competitors) {
        const compBrand = this.getBrandDisplayName(comp.brand);
        const avgWithIva =
          comp.marketplacePrices?.length
            ? comp.marketplacePrices.reduce((s: number, mp: any) => s + mp.priceWithIva, 0) / comp.marketplacePrices.length
            : 0;
        const avgWithoutIva =
          comp.marketplacePrices?.length
            ? comp.marketplacePrices.reduce((s: number, mp: any) => s + mp.priceWithoutIva, 0) / comp.marketplacePrices.length
            : 0;
        const avgPerIngredient: Record<string, number> = {};
        for (const ingId of Object.keys(comp.ingredientContent ?? {})) {
          const prices = (comp.marketplacePrices ?? [])
            .map((mp: any) => mp.pricePerIngredient?.[ingId] ?? 0)
            .filter((p: number) => p > 0);
          avgPerIngredient[ingId] = prices.length > 0 ? prices.reduce((a: number, b: number) => a + b, 0) / prices.length : 0;
        }
        allProducts.push({
          name: comp.name,
          brand: compBrand,
          priceWithIva: avgWithIva,
          priceWithoutIva: avgWithoutIva,
          pricePerIngredient: avgPerIngredient,
        });
      }

      const headerRow = ['Concepto', ...allProducts.map((p) => `${p.name} (${p.brand})`)];
      sheet.addRow(headerRow);
      this.setHeaderRowStyle(sheet, 1);

      sheet.addRow(['Precio sin IVA', ...allProducts.map((p) => this.formatCurrencyExcel(p.priceWithoutIva))]);
      sheet.addRow(['Precio con IVA', ...allProducts.map((p) => this.formatCurrencyExcel(p.priceWithIva))]);

      const ingredientIds = new Set<string>();
      Object.keys(product.currentPricePerIngredient ?? {}).forEach((id) => ingredientIds.add(id));
      detail.competitors.forEach((c: any) => Object.keys(c.ingredientContent ?? {}).forEach((id) => ingredientIds.add(id)));
      const ingredientList = Array.from(ingredientIds);

      for (const ingId of ingredientList) {
        const unit = detail.ingredientUnits?.[ingId] ?? 'unidad';
        const row = [
          `${ingId} (precio por ${unit})`,
          ...allProducts.map((p) => this.formatCurrencyExcel(p.pricePerIngredient?.[ingId] ?? null)),
        ];
        sheet.addRow(row);
      }
      this.setColumnWidthsFromContent(sheet);
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer as ArrayBuffer);
  }

  async acceptRecommendation(recommendationId: string, user: any): Promise<any> {
    return this.recommendationsService.acceptRecommendation(recommendationId, user);
  }

  async rejectRecommendation(recommendationId: string, user: any): Promise<any> {
    return this.recommendationsService.rejectRecommendation(recommendationId, user);
  }

  async bulkAcceptRecommendations(recommendationIds: string[], user: any): Promise<any> {
    return this.recommendationsService.bulkAcceptRecommendations(recommendationIds, user);
  }
}
