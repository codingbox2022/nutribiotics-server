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

  /**
   * Idempotently ensure the known seed marketplaces exist. Runs on every boot:
   * inserts any that are missing (matched by name or baseUrl), skips the rest.
   * Safe to run against a populated database.
   */
  async seedMarketplaces(): Promise<void> {
    let created = 0;
    for (const mp of marketplacesData as Array<Record<string, any>>) {
      try {
        const exists = await this.marketplaceModel
          .findOne({
            $or: [
              { name: { $regex: `^${mp.name}$`, $options: 'i' } },
              { baseUrl: mp.baseUrl },
            ],
          })
          .exec();
        if (exists) continue;

        await this.marketplaceModel.create({
          name: mp.name,
          country: mp.country || 'Colombia',
          ivaRate: mp.ivaRate ?? 0.19,
          baseUrl: mp.baseUrl,
          status: mp.status || 'active',
          scanStrategy: mp.scanStrategy || 'browser',
          seenByUser: mp.seenByUser ?? true,
        });
        created++;
        this.logger.log(`Seeded marketplace: ${mp.name} (${mp.scanStrategy || 'browser'})`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error seeding marketplace ${mp.name}: ${msg}`);
      }
    }
    if (created) {
      this.logger.log(`Seeded ${created} new known marketplace(s)`);
    }
  }

  /**
   * One-off, idempotent migration retiring the legacy "rejected" marketplace
   * concept. Rejected sites were non-indexed, so they become active and
   * browser-scanned. Also backfills scanStrategy and drops the obsolete
   * searchCapabilities / rejectionReason fields. Safe to run on every boot.
   */
  async migrateRetireRejected(): Promise<void> {
    const rejected = await this.marketplaceModel
      .updateMany(
        { status: 'rejected' },
        { $set: { status: 'active', scanStrategy: 'browser' } },
      )
      .exec();

    const backfilled = await this.marketplaceModel
      .updateMany(
        { scanStrategy: { $exists: false } },
        { $set: { scanStrategy: 'search' } },
      )
      .exec();

    // Drop obsolete fields; strict:false because they are no longer in the schema.
    const cleaned = await this.marketplaceModel
      .updateMany(
        {
          $or: [
            { searchCapabilities: { $exists: true } },
            { rejectionReason: { $exists: true } },
          ],
        },
        { $unset: { searchCapabilities: '', rejectionReason: '' } },
        { strict: false },
      )
      .exec();

    if (
      rejected.modifiedCount ||
      backfilled.modifiedCount ||
      cleaned.modifiedCount
    ) {
      this.logger.log(
        `Marketplace migration: ${rejected.modifiedCount} rejected→active/browser, ` +
          `${backfilled.modifiedCount} scanStrategy backfilled, ` +
          `${cleaned.modifiedCount} legacy fields removed`,
      );
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
