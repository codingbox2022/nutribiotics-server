import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
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
    try {
      const product = new this.productModel(createProductDto);
      return await product.save();
    } catch (error: any) {
      if (error.code === 11000) {
        throw new ConflictException(
          `Ya existe un producto con el nombre "${createProductDto.name}" y marca "${createProductDto.brand}"`,
        );
      }
      throw error;
    }
  }

  async createBulk(
    products: CreateProductDto[],
  ): Promise<{ mainProduct: ProductDocument; comparables: ProductDocument[] }> {
    // Validate all products don't already exist before creating any
    const duplicates: string[] = [];
    for (const product of products) {
      const existing = await this.productModel
        .findOne({ name: product.name, brand: product.brand })
        .exec();
      if (existing) {
        duplicates.push(`"${product.name}" (${product.brand})`);
      }
    }

    if (duplicates.length > 0) {
      throw new ConflictException(
        `Ya existen productos con estos nombres y marcas: ${duplicates.join(', ')}`,
      );
    }

    // Create all products
    const mainProduct = await this.create(products[0]);

    const comparables = await Promise.all(
      products.slice(1).map((p) =>
        this.create({
          ...p,
          comparedTo: mainProduct._id.toString(),
        }),
      ),
    );

    return { mainProduct, comparables };
  }

  async findAll(
    filters: FindAllFilters,
  ): Promise<PaginatedResult<any>> {
    const { page = 1, limit = 10, ...filterParams } = filters;
    const query: FilterQuery<ProductDocument> = {};

    // Only return original products (not compared products)
    query.comparedTo = null;

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

    const [originalProducts, total] = await Promise.all([
      this.productModel.find(query).skip(skip).limit(limit).exec(),
      this.productModel.countDocuments(query).exec(),
    ]);

    // For each original product, fetch its compared products
    const data = await Promise.all(
      originalProducts.map(async (product) => {
        const comparedProducts = await this.productModel
          .find({ comparedTo: product._id.toString() })
          .exec();

        return {
          ...product.toObject(),
          comparedProducts: comparedProducts.map((p) => p.toObject()),
        };
      }),
    );

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
    try {
      const product = await this.productModel
        .findByIdAndUpdate(id, updateProductDto, { new: true })
        .exec();
      if (!product) {
        throw new NotFoundException(`Product with ID ${id} not found`);
      }
      return product;
    } catch (error: any) {
      if (error.code === 11000) {
        throw new ConflictException(
          `Ya existe un producto con el nombre "${updateProductDto.name}" y marca "${updateProductDto.brand}"`,
        );
      }
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const result = await this.productModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
  }
}
