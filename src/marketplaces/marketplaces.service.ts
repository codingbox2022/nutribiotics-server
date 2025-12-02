import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { Marketplace, MarketplaceDocument } from './schemas/marketplace.schema';
import { CreateMarketplaceDto } from './dto/create-marketplace.dto';
import { UpdateMarketplaceDto } from './dto/update-marketplace.dto';
import { PaginatedResult } from '../common/interfaces/response.interface';

interface FindAllFilters {
  search?: string;
  country?: string;
  status?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class MarketplacesService {
  constructor(
    @InjectModel(Marketplace.name)
    private marketplaceModel: Model<MarketplaceDocument>,
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
      this.marketplaceModel.find(query).skip(skip).limit(limit).exec(),
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
    const result = await this.marketplaceModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`Marketplace with ID ${id} not found`);
    }
  }
}
