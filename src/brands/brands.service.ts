import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { Brand, BrandDocument } from './schemas/brand.schema';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { PaginatedResult } from '../common/interfaces/response.interface';
import brandsData from '../files/brands.json';
import { ApprovalStatus } from '../common/enums/approval-status.enum';

interface FindAllFilters {
  search?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class BrandsService {
  private readonly logger = new Logger(BrandsService.name);

  constructor(
    @InjectModel(Brand.name)
    private brandModel: Model<BrandDocument>,
  ) {}

  async create(createBrandDto: CreateBrandDto): Promise<BrandDocument> {
    const brand = new this.brandModel(createBrandDto);
    return brand.save();
  }

  async findAll(filters: FindAllFilters): Promise<PaginatedResult<BrandDocument>> {
    const { page = 1, limit = 10, search } = filters;
    const query: FilterQuery<BrandDocument> = {};

    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.brandModel.find(query).skip(skip).limit(limit).exec(),
      this.brandModel.countDocuments(query).exec(),
    ]);

    return {
      data,
      meta: { page, limit, total },
    };
  }

  async findOne(id: string): Promise<BrandDocument> {
    const brand = await this.brandModel.findById(id).exec();
    if (!brand) {
      throw new NotFoundException(`Brand with ID ${id} not found`);
    }
    return brand;
  }

  async update(id: string, updateBrandDto: UpdateBrandDto): Promise<BrandDocument> {
    const brand = await this.brandModel
      .findByIdAndUpdate(id, updateBrandDto, { new: true })
      .exec();
    if (!brand) {
      throw new NotFoundException(`Brand with ID ${id} not found`);
    }
    return brand;
  }

  async remove(id: string): Promise<void> {
    const result = await this.brandModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`Brand with ID ${id} not found`);
    }
  }

  async seedBrands(): Promise<void> {
    const count = await this.brandModel.countDocuments().exec();
    this.logger.log(`Current brand count: ${count}`);
    if (count > 0) {
      this.logger.log('Brands already seeded');
      return;
    }

    this.logger.log(`Brands data length: ${brandsData.length}`);
    try {
      const normalizedData = brandsData.map((brand) => ({
        ...brand,
        status: ApprovalStatus.APPROVED,
      }));

      await this.brandModel.insertMany(normalizedData);
      this.logger.log(`Seeded ${brandsData.length} brands`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error seeding brands: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
    }
  }

  async findPending(): Promise<BrandDocument[]> {
    return this.brandModel
      .find({ status: ApprovalStatus.NOT_APPROVED })
      .exec();
  }

  async acceptPending(id: string, name: string): Promise<BrandDocument> {
    const brand = await this.brandModel
      .findByIdAndUpdate(
        id,
        { name, status: ApprovalStatus.APPROVED },
        { new: true },
      )
      .exec();
    if (!brand) {
      throw new NotFoundException(`Brand with ID ${id} not found`);
    }
    return brand;
  }

  async rejectPending(id: string): Promise<void> {
    const result = await this.brandModel
      .findByIdAndUpdate(id, { status: ApprovalStatus.REJECTED }, { new: true })
      .exec();
    if (!result) {
      throw new NotFoundException(`Brand with ID ${id} not found`);
    }
  }
}
