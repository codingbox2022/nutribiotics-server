import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { Ingredient, IngredientDocument } from '../ingredients/schemas/ingredient.schema';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { PaginatedResult } from '../common/interfaces/response.interface';
import { PricesService } from '../prices/prices.service';
import productsData from '../files/products.json';

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
    @InjectModel(Ingredient.name) private ingredientModel: Model<IngredientDocument>,
    private pricesService: PricesService,
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

  private async populateIngredientNames(ingredientsMap: Map<string, number>): Promise<Record<string, number>> {
    if (!ingredientsMap || ingredientsMap.size === 0) {
      return {};
    }

    const ingredientIds = Array.from(ingredientsMap.keys());
    const ingredients = await this.ingredientModel.find({ _id: { $in: ingredientIds } }).exec();

    const result: Record<string, number> = {};
    for (const [id, amount] of ingredientsMap.entries()) {
      const ingredient = ingredients.find(ing => ing._id.toString() === id);
      if (ingredient) {
        result[ingredient.name] = amount;
      }
    }

    return result;
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

    // For each original product, fetch its compared products and latest price
    const data = await Promise.all(
      originalProducts.map(async (product) => {
        const [comparedProducts, prices, populatedIngredients] = await Promise.all([
          this.productModel
            .find({ comparedTo: product._id.toString() })
            .exec(),
          this.pricesService.findAll({
            productId: product._id.toString(),
            limit: 1,
          }),
          this.populateIngredientNames(product.ingredients),
        ]);

        const latestPrice = prices.data.length > 0 ? prices.data[0].value : null;

        const productObj = product.toObject();

        // Populate ingredients for compared products as well
        const comparedProductsWithIngredients = await Promise.all(
          comparedProducts.map(async (p) => {
            const pObj = p.toObject();
            const pIngredients = await this.populateIngredientNames(p.ingredients);
            return {
              ...pObj,
              ingredients: pIngredients,
            };
          })
        );

        return {
          ...productObj,
          ingredients: populatedIngredients,
          comparedProducts: comparedProductsWithIngredients,
          latestPrice,
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

  async addComparables(
    mainProductId: string,
    comparables: CreateProductDto[],
  ): Promise<ProductDocument[]> {
    // Validate main product exists and is a main product (not a comparable)
    const mainProduct = await this.productModel.findById(mainProductId).exec();
    if (!mainProduct) {
      throw new NotFoundException(
        `Main product with ID ${mainProductId} not found`,
      );
    }

    if (mainProduct.comparedTo) {
      throw new ConflictException(
        `Product with ID ${mainProductId} is not a main product. Cannot add comparables to a comparable product.`,
      );
    }

    // Validate all comparables don't already exist before creating any
    const duplicates: string[] = [];
    for (const comparable of comparables) {
      const existing = await this.productModel
        .findOne({ name: comparable.name, brand: comparable.brand })
        .exec();
      if (existing) {
        duplicates.push(`"${comparable.name}" (${comparable.brand})`);
      }
    }

    if (duplicates.length > 0) {
      throw new ConflictException(
        `Ya existen productos con estos nombres y marcas: ${duplicates.join(', ')}`,
      );
    }

    // Create all comparable products
    const createdComparables = await Promise.all(
      comparables.map((c) =>
        this.create({
          ...c,
          comparedTo: mainProductId,
        }),
      ),
    );

    return createdComparables;
  }

  async seedProducts(): Promise<void> {
    const count = await this.productModel.countDocuments().exec();
    console.log(`Current product count: ${count}`);
    if (count > 0) {
      console.log('Products already seeded');
      return;
    }

    console.log(`Products data length: ${productsData.length}`);
    try {
      let totalSeeded = 0;

      for (const productData of productsData) {
        const { comparables, ...mainProductData } = productData;

        const mainProduct = await this.productModel.create({
          ...mainProductData,
          ingredients: new Map(Object.entries(mainProductData.ingredients)),
          comparedTo: null,
        });
        totalSeeded++;

        if (comparables && comparables.length > 0) {
          for (const comparable of comparables) {
            await this.productModel.create({
              ...comparable,
              ingredients: new Map(Object.entries(comparable.ingredients)),
              comparedTo: mainProduct._id,
            });
            totalSeeded++;
          }
        }
      }

      console.log(`Seeded ${totalSeeded} products (${productsData.length} main + comparables)`);
    } catch (error) {
      console.error('Error seeding products:', error);
    }
  }
}
