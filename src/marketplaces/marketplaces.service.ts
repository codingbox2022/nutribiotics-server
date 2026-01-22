import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { Marketplace, MarketplaceDocument } from './schemas/marketplace.schema';
import { CreateMarketplaceDto } from './dto/create-marketplace.dto';
import { UpdateMarketplaceDto } from './dto/update-marketplace.dto';
import { PaginatedResult } from '../common/interfaces/response.interface';
import marketplacesData from '../files/marketplaces.json';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { Price, PriceDocument } from '../prices/schemas/price.schema';
import { ProductsService } from '../products/products.service';
import { generateText } from 'ai';
import { google } from 'src/providers/googleAiProvider';

interface FindAllFilters {
  search?: string;
  country?: string;
  status?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class MarketplacesService {
  private readonly logger = new Logger(MarketplacesService.name);

  constructor(
    @InjectModel(Marketplace.name)
    private marketplaceModel: Model<MarketplaceDocument>,
    @InjectModel(Product.name)
    private productModel: Model<ProductDocument>,
    @InjectModel(Price.name)
    private priceModel: Model<PriceDocument>,
    private productsService: ProductsService,
  ) {}

  async create(
    createMarketplaceDto: CreateMarketplaceDto,
  ): Promise<MarketplaceDocument> {
    const marketplace = new this.marketplaceModel(createMarketplaceDto);
    return marketplace.save();
  }

  async findAll(
    filters: FindAllFilters,
  ): Promise<PaginatedResult<MarketplaceDocument>> {
    const { page = 1, limit = 10, ...filterParams } = filters;
    const query: FilterQuery<MarketplaceDocument> = {};

    if (filterParams.search) {
      query.name = { $regex: filterParams.search, $options: 'i' };
    }

    if (filterParams.country) {
      query.country = filterParams.country;
    }

    if (filterParams.status) {
      query.status = filterParams.status;
    }

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.marketplaceModel.find(query).sort({ name: 1 }).skip(skip).limit(limit).exec(),
      this.marketplaceModel.countDocuments(query).exec(),
    ]);

    return {
      data,
      meta: { page, limit, total },
    };
  }

  async findOne(id: string): Promise<MarketplaceDocument> {
    const marketplace = await this.marketplaceModel.findById(id).exec();
    if (!marketplace) {
      throw new NotFoundException(`Marketplace with ID ${id} not found`);
    }
    return marketplace;
  }

  async update(
    id: string,
    updateMarketplaceDto: UpdateMarketplaceDto,
  ): Promise<MarketplaceDocument> {
    const marketplace = await this.marketplaceModel
      .findByIdAndUpdate(id, updateMarketplaceDto, { new: true })
      .exec();
    if (!marketplace) {
      throw new NotFoundException(`Marketplace with ID ${id} not found`);
    }
    return marketplace;
  }

  async remove(id: string): Promise<void> {
    const marketplace = await this.marketplaceModel.findById(id).exec();
    if (!marketplace) {
      throw new NotFoundException(`Marketplace with ID ${id} not found`);
    }

    // Delete all prices associated with this marketplace
    const deleteResult = await this.priceModel.deleteMany({ marketplaceId: id }).exec();
    this.logger.log(`Deleted ${deleteResult.deletedCount} prices for marketplace ${marketplace.name}`);

    // Delete the marketplace
    await this.marketplaceModel.findByIdAndDelete(id).exec();
    this.logger.log(`Deleted marketplace ${marketplace.name} (${id})`);
  }

  async seedMarketplaces(): Promise<void> {
    const count = await this.marketplaceModel.countDocuments().exec();
    this.logger.log(`Current marketplace count: ${count}`);
    if (count > 0) {
      this.logger.log('Marketplaces already seeded');
      return;
    }

    this.logger.log(`Marketplaces data length: ${marketplacesData.length}`);
    try {
      await this.marketplaceModel.insertMany(marketplacesData);
      this.logger.log(`Seeded ${marketplacesData.length} marketplaces`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error seeding marketplaces: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
    }
  }

  async discoverMarketplacesFromProducts(): Promise<MarketplaceDocument[]> {
    const COUNTRY = 'Colombia';
    const IVA_RATE = 0.19;

    try {
      this.logger.log('Starting marketplace discovery from products...');

      // Get all active products with brand information
      const products = await this.productModel
        .find({ status: 'active', comparedTo: null })
        .populate({ path: 'brand', select: 'name' })
        .exec();

      this.logger.log(`Found ${products.length} active products`);

      if (products.length === 0) {
        this.logger.warn('No active products found. Skipping marketplace discovery.');
        return [];
      }

      // Build product list in "Brand → Name" format
      const productList = products
        .map((product) => {
          const brandName = (product.brand as any)?.name || 'Unknown';
          return `${brandName} → ${product.name}`;
        })
        .join('\n');

      // Get existing marketplace names to exclude
      const existingMarketplaces = await this.marketplaceModel
        .find({ country: COUNTRY })
        .select('name')
        .exec();

      const existingMarketplaceNames = existingMarketplaces
        .map((m) => m.name)
        .join(', ');

      // Build prompt for LLM
      const prompt = `<instructions>
Given this list of products (in format "Brand → Product Name"), find online stores/marketplaces in ${COUNTRY} where these products are sold.

Return each marketplace in the following format, one per line:
MarketplaceName | BaseURL

Important requirements:
- BaseURL must be the store's homepage (e.g., https://example.com), NOT product pages
- Only include marketplaces that are NOT already in the existing list
- Focus on legitimate online stores that sell nutritional supplements in ${COUNTRY}
- Each line must follow exactly this format: Name | URL
</instructions>

<productList>
${productList}
</productList>

${existingMarketplaceNames ? `<excludeMarketplaces>
DO NOT include these marketplaces as they are already in the database:
${existingMarketplaceNames}
</excludeMarketplaces>` : ''}

<country>${COUNTRY}</country>`;

      // Call LLM with web search
      this.logger.log('Calling LLM to discover marketplaces...');
      const { text } = await generateText({
        model: google('gemini-3-pro-preview'),
        prompt,
        tools: {
          google_search: google.tools.googleSearch({}),
        }
      });

      this.logger.log('LLM response received. Parsing results...');

      // Parse response - extract lines in format "Name | URL"
      const lines = text.split('\n').filter((line) => line.trim());
      const marketplacesToCreate: CreateMarketplaceDto[] = [];

      for (const line of lines) {
        const trimmedLine = line.trim();
        // Look for lines with the pattern "Name | URL"
        if (trimmedLine.includes('|')) {
          const parts = trimmedLine.split('|').map((p) => p.trim());
          if (parts.length >= 2) {
            const [name, rawUrl] = parts;
            // Basic validation and URL cleanup
            if (name && rawUrl && rawUrl.startsWith('http')) {
              // Clean URL: remove UTM parameters and other query strings
              let cleanUrl = rawUrl;
              try {
                const url = new URL(rawUrl);
                // Keep only protocol, hostname, and port (if any)
                cleanUrl = `${url.protocol}//${url.host}`;
              } catch (error) {
                this.logger.warn(`Failed to parse URL: ${rawUrl}. Using as-is.`);
              }

              marketplacesToCreate.push({
                name,
                baseUrl: cleanUrl,
                country: COUNTRY,
                ivaRate: IVA_RATE,
                status: 'active',
                seenByUser: false,
              });
            }
          }
        }
      }

      this.logger.log(`Parsed ${marketplacesToCreate.length} marketplaces from LLM response`);

      // Create marketplaces in database
      const createdMarketplaces: MarketplaceDocument[] = [];
      for (const marketplaceDto of marketplacesToCreate) {
        try {
          // Check if marketplace already exists (by name or baseUrl)
          const existing = await this.marketplaceModel
            .findOne({
              $or: [
                { name: { $regex: `^${marketplaceDto.name}$`, $options: 'i' } },
                { baseUrl: marketplaceDto.baseUrl },
              ],
            })
            .exec();

          if (!existing) {
            const marketplace = await this.create(marketplaceDto);
            createdMarketplaces.push(marketplace);
            this.logger.log(`Created marketplace: ${marketplaceDto.name}`);
          } else {
            this.logger.log(`Skipping duplicate marketplace: ${marketplaceDto.name}`);
          }
        } catch (error) {
          this.logger.error(
            `Error creating marketplace ${marketplaceDto.name}:`,
            error,
          );
        }
      }

      this.logger.log(
        `Marketplace discovery complete. Created ${createdMarketplaces.length} new marketplaces.`,
      );
      return createdMarketplaces;
    } catch (error) {
      this.logger.error('Error in discoverMarketplacesFromProducts:', error);
      throw error;
    }
  }

  async findUnseen(): Promise<{ count: number; marketplaces: MarketplaceDocument[] }> {
    const unseenMarketplaces = await this.marketplaceModel
      .find({ seenByUser: false })
      .sort({ createdAt: -1 })
      .exec();

    return {
      count: unseenMarketplaces.length,
      marketplaces: unseenMarketplaces,
    };
  }

  async markAllAsSeen(): Promise<{ updated: number }> {
    const result = await this.marketplaceModel
      .updateMany(
        { seenByUser: false },
        { $set: { seenByUser: true } },
      )
      .exec();

    this.logger.log(`Marked ${result.modifiedCount} marketplaces as seen`);
    return { updated: result.modifiedCount };
  }
}
