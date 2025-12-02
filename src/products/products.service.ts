import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { PaginatedResult } from '../common/interfaces/response.interface';

interface FindAllFilters {
  search?: string;
  line?: string;
  segment?: string;
  form?: string;
  alertLevel?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
  ) {}

  async create(createProductDto: CreateProductDto): Promise<ProductDocument> {
    const product = new this.productModel(createProductDto);
    return product.save();
  }

  async findAll(
    filters: FindAllFilters,
  ): Promise<PaginatedResult<ProductDocument>> {
    const { page = 1, limit = 10, ...filterParams } = filters;
    const query: FilterQuery<ProductDocument> = {};

    if (filterParams.search) {
      query.$or = [
        { name: { $regex: filterParams.search, $options: 'i' } },
        { sku: { $regex: filterParams.search, $options: 'i' } },
      ];
    }

    if (filterParams.line) {
      query.line = filterParams.line;
    }

    if (filterParams.segment) {
      query.segment = filterParams.segment;
    }

    if (filterParams.form) {
      query.form = filterParams.form;
    }

    if (filterParams.alertLevel) {
      query.alertLevel = filterParams.alertLevel;
    }

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.productModel.find(query).skip(skip).limit(limit).exec(),
      this.productModel.countDocuments(query).exec(),
    ]);

    return {
      data,
      meta: { page, limit, total },
    };
  }

  async findOne(id: string): Promise<ProductDocument> {
    const product = await this.productModel.findById(id).exec();
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return product;
  }

  async update(
    id: string,
    updateProductDto: UpdateProductDto,
  ): Promise<ProductDocument> {
    const product = await this.productModel
      .findByIdAndUpdate(id, updateProductDto, { new: true })
      .exec();
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return product;
  }

  async remove(id: string): Promise<void> {
    const result = await this.productModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
  }
}
