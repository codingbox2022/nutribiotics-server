import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, Types } from 'mongoose';
import { PresentationType, Product, ProductDocument, ProductIngredient } from './schemas/product.schema';
import { Ingredient, IngredientDocument, MeasurementUnit } from '../ingredients/schemas/ingredient.schema';
import { Brand, BrandDocument } from '../brands/schemas/brand.schema';
import { ApprovalStatus } from '../common/enums/approval-status.enum';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { PaginatedResult } from '../common/interfaces/response.interface';
import { PricesService } from '../prices/prices.service';
import productsData from '../files/products.json';
import { generateText, Output } from 'ai';
import z from 'zod';
import fs from 'fs';
import { google } from 'src/providers/googleAiProvider';

interface FindAllFilters {
  search?: string;
  line?: string;
  segment?: string;
  form?: string;
  alertLevel?: string;
  page?: number;
  limit?: number;
}

const COUNTRY = 'Colombia';

type IngredientInput = {
  ingredientId: string;
  quantity: number | null;
};

type IngredientDisplay = {
  id: string;
  name: string | null;
  quantity: number | null;
};

type BrandDisplay = {
  id: string;
  name: string | null;
};

type ProductResponse = {
  [key: string]: any;
  id: string;
  brand: BrandDisplay | null;
  ingredients: IngredientDisplay[];
  ingredientQuantities: Record<string, number | null>;
};

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(Ingredient.name) private ingredientModel: Model<IngredientDocument>,
    @InjectModel(Brand.name) private brandModel: Model<BrandDocument>,
    private pricesService: PricesService,
  ) {}

  private normalizeIngredients(
    ingredients: IngredientInput[] = [],
  ): { ingredient: Types.ObjectId; quantity: number | null }[] {
    return ingredients.map(({ ingredientId, quantity }) => ({
      ingredient: new Types.ObjectId(ingredientId),
      quantity,
    }));
  }

  private documentIngredientsToInputs(
    ingredients: ProductIngredient[] | undefined,
  ): IngredientInput[] {
    if (!ingredients) {
      return [];
    }

    return ingredients
      .map((entry) => {
        const ref: any = entry.ingredient;
        if (!ref) {
          return null;
        }

        if (ref instanceof Types.ObjectId) {
          return { ingredientId: ref.toString(), quantity: entry.quantity };
        }

        if (typeof ref === 'string') {
          return { ingredientId: ref, quantity: entry.quantity };
        }

        if (ref._id) {
          return { ingredientId: ref._id.toString(), quantity: entry.quantity };
        }

        return null;
      })
      .filter((entry): entry is IngredientInput => entry !== null);
  }

  private formatBrand(brand: Types.ObjectId | BrandDocument | null | undefined): BrandDisplay | null {
    if (!brand) {
      return null;
    }

    if (brand instanceof Types.ObjectId) {
      return { id: brand.toString(), name: null };
    }

    if (typeof brand === 'string') {
      return { id: brand, name: null };
    }

    return {
      id: brand._id.toString(),
      name: brand.name,
    };
  }

  private formatIngredients(ingredients: ProductIngredient[] | undefined): IngredientDisplay[] {
    if (!ingredients || ingredients.length === 0) {
      return [];
    }

    return ingredients
      .map((entry) => {
        const ref: any = entry.ingredient;
        if (!ref) {
          return null;
        }

        if (ref instanceof Types.ObjectId || typeof ref === 'string') {
          return {
            id: ref.toString(),
            name: null,
            quantity: entry.quantity,
          };
        }

        return {
          id: ref._id?.toString() ?? '',
          name: ref.name ?? null,
          quantity: entry.quantity,
        };
      })
      .filter((entry): entry is IngredientDisplay => Boolean(entry && entry.id));
  }

  private async hydrateBrand(
    brand: Types.ObjectId | BrandDocument | null | undefined,
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

  private async hydrateIngredients(
    ingredients: ProductIngredient[] | undefined,
  ): Promise<IngredientDisplay[]> {
    const formatted = this.formatIngredients(ingredients);

    const missingIds = formatted
      .filter((item) => !item.name)
      .map((item) => item.id);

    if (missingIds.length === 0) {
      return formatted;
    }

    const docs = await this.ingredientModel
      .find({ _id: { $in: missingIds } })
      .select('name')
      .exec();

    const names = new Map(docs.map((doc) => [doc._id.toString(), doc.name]));

    return formatted.map((item) => ({
      ...item,
      name: item.name ?? names.get(item.id) ?? null,
    }));
  }

  private async normalizeIngredientContentMap(
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

  private buildIngredientQuantities(
    ingredients: IngredientDisplay[],
  ): Record<string, number | null> {
    return ingredients.reduce<Record<string, number | null>>((acc, ingredient) => {
      if (ingredient.id) {
        acc[ingredient.id] = ingredient.quantity;
      }
      return acc;
    }, {});
  }

  private async buildProductResponse(product: ProductDocument): Promise<ProductResponse> {
    const [brand, ingredients, ingredientContent] = await Promise.all([
      this.hydrateBrand(product.brand as any),
      this.hydrateIngredients(product.ingredients as any),
      this.normalizeIngredientContentMap(product.ingredientContent as any),
    ]);

    const ingredientQuantities = this.buildIngredientQuantities(ingredients);

    const productObj = product.toObject({ virtuals: true });
    const {
      _id,
      id,
      brand: _brand,
      ingredients: _ingredients,
      ingredientContent: _ingredientContent,
      ...rest
    } = productObj as any;

    return {
      id: (id ?? _id ?? product._id).toString(),
      ...rest,
      brand,
      ingredients,
      ingredientQuantities,
      ingredientContent,
    };
  }

  private async resolveBrandIdByName(brandName: string): Promise<Types.ObjectId> {
    const normalized = brandName.trim();
    const existing = await this.brandModel
      .findOne({ name: { $regex: `^${normalized}$`, $options: 'i' } })
      .exec();

    if (existing) {
      return existing._id;
    }

    const newBrand = new this.brandModel({ name: normalized.toUpperCase() });
    await newBrand.save();
    return newBrand._id;
  }

  private async mapSeedIngredients(
    seedIngredients: { name: string; quantity: number | null }[],
  ): Promise<IngredientInput[]> {
    if (!seedIngredients || seedIngredients.length === 0) {
      return [];
    }

    const names = seedIngredients.map((ing) => ing.name.trim().toUpperCase());
    const docs = await this.ingredientModel
      .find({ name: { $in: names } })
      .select('name')
      .exec();

    const map = new Map(docs.map((doc) => [doc.name.toUpperCase(), doc._id.toString()]));

    return seedIngredients.reduce<IngredientInput[]>((acc, ing) => {
      const id = map.get(ing.name.trim().toUpperCase());
      if (!id) {
        this.logger.warn(`Ingredient "${ing.name}" not found while seeding products. Skipping.`);
        return acc;
      }

      let quantity: number | null = ing.quantity;
      if (typeof ing.quantity === 'string') {
        if (ing.quantity === 'NO REPORTA' || ing.quantity === 'NO INF.') {
          quantity = null;
        } else {
          const parsed = Number(ing.quantity);
          quantity = isNaN(parsed) ? null : parsed;
        }
      }

      acc.push({ ingredientId: id, quantity });
      return acc;
    }, []);
  }

  private calculateIngredientContent(
    ingredients: IngredientInput[],
    totalContent: number,
    portion: number,
  ): Map<string, number> {
    const ingredientContent = new Map<string, number>();

    for (const { ingredientId, quantity } of ingredients) {
      if (quantity == null) continue;
      // Ingredient Content = (totalContent × ingredient_quantity) ÷ portion
      const content = (totalContent * quantity) / portion;
      ingredientContent.set(ingredientId, content);
    }

    return ingredientContent;
  }

  async create(
    createProductDto: CreateProductDto,
    options?: { status?: 'active' | 'inactive' | 'rejected' | 'deleted' },
  ): Promise<ProductResponse> {
    try {
      const { ingredients, brand, name, ...rest } = createProductDto;
      const status = options?.status ?? 'active';
      const normalizedName = name.trim().toUpperCase();

      // Validate comparedTo logic: non-Nutribiotics products must have comparedTo
      const brandDoc = await this.brandModel.findById(brand).exec();
      if (!brandDoc) {
        throw new NotFoundException(`Brand with ID ${brand} not found`);
      }

      const isNutrabioticsProduct = brandDoc.name.toUpperCase() === 'NUTRABIOTICS';

      if (!isNutrabioticsProduct && !createProductDto.comparedTo) {
        throw new ConflictException(
          `Products from brands other than Nutrabiotics must be linked to a Nutrabiotics product. ` +
          `Please provide a 'comparedTo' reference or create the products together using the bulk endpoint.`,
        );
      }

      if (isNutrabioticsProduct && createProductDto.comparedTo) {
        throw new ConflictException(
          `Nutrabiotics products cannot have a 'comparedTo' reference. ` +
          `They should be the main products that other products compare to.`,
        );
      }

      const ingredientContent = this.calculateIngredientContent(
        ingredients,
        createProductDto.totalContent,
        createProductDto.portion,
      );

      const normalizedIngredients = this.normalizeIngredients(ingredients);

      const product = new this.productModel({
        ...rest,
        name: normalizedName,
        brand: new Types.ObjectId(brand),
        ingredients: normalizedIngredients,
        ingredientContent,
        status,
        comparedTo: createProductDto.comparedTo,
      });

      await product.save();
      await product.populate([
        { path: 'brand', select: 'name status' },
        { path: 'ingredients.ingredient', select: 'name status' },
      ]);
      return this.buildProductResponse(product);
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
  ): Promise<{ mainProduct: ProductResponse; comparables: ProductResponse[] }> {
    if (products.length === 0) {
      throw new ConflictException('At least one product is required');
    }

    // Validate that the first product is a Nutribiotics product
    const mainProductBrand = await this.brandModel.findById(products[0].brand).exec();
    if (!mainProductBrand) {
      throw new NotFoundException(`Brand with ID ${products[0].brand} not found`);
    }

    if (mainProductBrand.name.toUpperCase() !== 'NUTRABIOTICS') {
      throw new ConflictException(
        `The first product in bulk creation must be a Nutrabiotics product. ` +
        `Received brand: ${mainProductBrand.name}`,
      );
    }

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
          comparedTo: new Types.ObjectId(mainProduct.id),
        }),
      ),
    );

    return { mainProduct, comparables };
  }

  async findPending(): Promise<ProductResponse[]> {
    const pendingProducts = await this.productModel
      .find({ status: 'inactive' })
      .sort({ createdAt: -1 })
      .populate([
        { path: 'brand', select: 'name status' },
        { path: 'ingredients.ingredient', select: 'name status' },
      ])
      .lean()
      .exec();

    if (pendingProducts.length === 0) {
      return [];
    }

    // BATCH: Get all comparedTo product IDs and fetch them at once
    const comparedToIds = pendingProducts
      .map(p => p.comparedTo)
      .filter((id): id is Types.ObjectId => Boolean(id));

    const comparedToProducts = comparedToIds.length > 0
      ? await this.productModel
          .find({ _id: { $in: comparedToIds } })
          .populate({ path: 'brand', select: 'name status' })
          .lean()
          .exec()
      : [];

    const comparedToMap = new Map<string, any>();
    for (const product of comparedToProducts) {
      comparedToMap.set(product._id.toString(), product);
    }

    // BATCH: Get all unique ingredient IDs for ingredientContent normalization
    const allIngredientIds = new Set<string>();
    for (const product of pendingProducts) {
      if (product.ingredientContent) {
        const entries = product.ingredientContent instanceof Map
          ? Array.from(product.ingredientContent.keys())
          : Object.keys(product.ingredientContent);
        for (const id of entries) {
          if (Types.ObjectId.isValid(id)) {
            allIngredientIds.add(id);
          }
        }
      }
    }

    const ingredientDocs = allIngredientIds.size > 0
      ? await this.ingredientModel
          .find({ _id: { $in: Array.from(allIngredientIds) } })
          .select('name')
          .lean()
          .exec()
      : [];

    const ingredientNameMap = new Map<string, string>();
    for (const doc of ingredientDocs) {
      ingredientNameMap.set(doc._id.toString(), doc.name);
    }

    // Build responses using in-memory lookups
    const data = pendingProducts.map((product) => {
      // Format brand (already populated)
      const brandRef: any = product.brand;
      const brand: BrandDisplay | null = brandRef
        ? { id: brandRef._id?.toString() || brandRef.toString(), name: brandRef.name || null }
        : null;

      // Format ingredients (already populated)
      const ingredients: IngredientDisplay[] = (product.ingredients || [])
        .map((entry: any) => {
          const ref = entry.ingredient;
          if (!ref) return null;
          return {
            id: ref._id?.toString() || ref.toString(),
            name: ref.name || null,
            quantity: entry.quantity,
          };
        })
        .filter((entry): entry is IngredientDisplay => Boolean(entry && entry.id));

      // Build ingredient quantities
      const ingredientQuantities = ingredients.reduce<Record<string, number | null>>((acc, ing) => {
        if (ing.id) acc[ing.id] = ing.quantity;
        return acc;
      }, {});

      // Normalize ingredient content using pre-loaded map
      const ingredientContent: Record<string, number> = {};
      if (product.ingredientContent) {
        const entries = product.ingredientContent instanceof Map
          ? Array.from(product.ingredientContent.entries())
          : Object.entries(product.ingredientContent);
        for (const [id, value] of entries) {
          const key = ingredientNameMap.get(id) || id;
          ingredientContent[key] = Number(value);
        }
      }

      // Get comparedTo product from map
      const comparedToProduct = product.comparedTo
        ? comparedToMap.get(product.comparedTo.toString())
        : null;

      // Extract pending ingredient IDs
      const pendingIngredientIds = (product.ingredients || [])
        .map((entry: any) => {
          const ref = entry.ingredient;
          if (ref?.status === 'not_approved') {
            return ref._id?.toString() || ref.toString();
          }
          return null;
        })
        .filter((value): value is string => Boolean(value));

      // Extract pending brand IDs
      const pendingBrandIds: string[] = [];
      if (brandRef?.status === 'not_approved') {
        pendingBrandIds.push(brandRef._id?.toString() || brandRef.toString());
      }

      // Format comparedTo brand
      const comparedToBrandRef: any = comparedToProduct?.brand;
      const comparedToBrand: BrandDisplay | null = comparedToBrandRef
        ? { id: comparedToBrandRef._id?.toString() || comparedToBrandRef.toString(), name: comparedToBrandRef.name || null }
        : null;

      const productObj = product as any;

      return {
        id: product._id.toString(),
        name: product.name,
        totalContent: product.totalContent,
        presentation: product.presentation,
        portion: product.portion,
        imageUrl: product.imageUrl,
        alertLevel: product.alertLevel,
        lastScanDate: product.lastScanDate,
        scanStatus: product.scanStatus,
        status: product.status,
        createdAt: productObj.createdAt,
        updatedAt: productObj.updatedAt,
        brand,
        ingredients,
        ingredientQuantities,
        ingredientContent,
        comparesTo: comparedToProduct
          ? {
              id: comparedToProduct._id.toString(),
              name: comparedToProduct.name,
              brand: comparedToBrand,
            }
          : null,
        pendingIngredientIds,
        pendingBrandIds,
        hasPendingDependencies: pendingIngredientIds.length > 0 || pendingBrandIds.length > 0,
      };
    });

    return data;
  }

  async acceptWithDependencies(
    productId: string,
    productName?: string,
  ): Promise<{
    product: ProductResponse;
    acceptedIngredients: string[];
    acceptedBrands: string[];
  }> {
    // 1. Load the product with populated refs
    const product = await this.productModel
      .findById(productId)
      .populate([
        { path: 'brand', select: 'name status' },
        { path: 'ingredients.ingredient', select: 'name status' },
      ])
      .exec();

    if (!product) {
      throw new NotFoundException(`Product with ID ${productId} not found`);
    }

    const acceptedIngredients: string[] = [];
    const acceptedBrands: string[] = [];

    // 2. Accept all pending ingredients
    for (const entry of product.ingredients || []) {
      const ref: any = entry.ingredient;
      if (ref?.status === ApprovalStatus.NOT_APPROVED) {
        await this.ingredientModel.findByIdAndUpdate(
          ref._id,
          { status: ApprovalStatus.APPROVED },
          { new: true },
        );
        acceptedIngredients.push(ref._id.toString());
      }
    }

    // 3. Accept the pending brand
    const brandRef: any = product.brand;
    if (brandRef?.status === ApprovalStatus.NOT_APPROVED) {
      await this.brandModel.findByIdAndUpdate(
        brandRef._id,
        { status: ApprovalStatus.APPROVED },
        { new: true },
      );
      acceptedBrands.push(brandRef._id.toString());
    }

    // 4. Activate the product
    const updateData: Record<string, unknown> = { status: 'active' };
    if (productName) {
      updateData.name = productName;
    }

    const updatedProduct = await this.productModel
      .findByIdAndUpdate(productId, updateData, { new: true })
      .populate([
        { path: 'brand', select: 'name status' },
        { path: 'ingredients.ingredient', select: 'name status' },
      ])
      .exec();

    return {
      product: await this.buildProductResponse(updatedProduct!),
      acceptedIngredients,
      acceptedBrands,
    };
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

    const populateOpts = [
      { path: 'brand', select: 'name status' },
      { path: 'ingredients.ingredient', select: 'name status' },
    ];

    // Step 1: Fetch paginated products + count
    const [originalProducts, total] = await Promise.all([
      this.productModel
        .find(query)
        .skip(skip)
        .limit(limit)
        .populate(populateOpts)
        .exec(),
      this.productModel.countDocuments(query).exec(),
    ]);

    const productIds = originalProducts.map((p) => p._id);

    // Step 2: Batch fetch ALL compared products + ALL latest prices (instead of N+1 queries)
    const [allComparedProducts, latestPricesMap] = await Promise.all([
      productIds.length > 0
        ? this.productModel
            .find({ comparedTo: { $in: productIds } })
            .populate(populateOpts)
            .exec()
        : [],
      this.pricesService.getLatestPricesForProducts(productIds),
    ]);

    // Step 3: Group compared products by parent ID
    const comparedByParent = new Map<string, ProductDocument[]>();
    for (const cp of allComparedProducts) {
      const parentId = cp.comparedTo!.toString();
      const list = comparedByParent.get(parentId);
      if (list) {
        list.push(cp);
      } else {
        comparedByParent.set(parentId, [cp]);
      }
    }

    // Step 4: Build responses (buildProductResponse only resolves missing refs, fast when populated)
    const data = await Promise.all(
      originalProducts.map(async (product) => {
        const [baseProduct, comparedProductResponses] = await Promise.all([
          this.buildProductResponse(product),
          Promise.all(
            (comparedByParent.get(product._id.toString()) || []).map((p) =>
              this.buildProductResponse(p),
            ),
          ),
        ]);

        return {
          ...baseProduct,
          comparedProducts: comparedProductResponses,
          latestPrice: latestPricesMap.get(product._id.toString()) ?? null,
        };
      }),
    );

    return {
      data,
      meta: { page, limit, total },
    };
  }

  async findOne(id: string): Promise<ProductResponse> {
    const product = await this.productModel
      .findById(id)
      .populate([
        { path: 'brand', select: 'name status' },
        { path: 'ingredients.ingredient', select: 'name status' },
      ])
      .exec();
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return this.buildProductResponse(product);
  }

  async update(
    id: string,
    updateProductDto: UpdateProductDto,
  ): Promise<ProductResponse> {
    try {
      // Get current product to check if we need to recalculate ingredientContent
      const currentProduct = await this.productModel.findById(id).exec();
      if (!currentProduct) {
        throw new NotFoundException(`Product with ID ${id} not found`);
      }

      // Recalculate ingredient content if any related fields changed
      const hasIngredientUpdates = Array.isArray(updateProductDto.ingredients);
      const shouldRecalculate =
        hasIngredientUpdates ||
        updateProductDto.totalContent !== undefined ||
        updateProductDto.portion !== undefined;

      let ingredientContent: Map<string, number> | undefined;
      if (shouldRecalculate) {
        const ingredientInputs = hasIngredientUpdates
          ? (updateProductDto.ingredients as IngredientInput[])
          : this.documentIngredientsToInputs(currentProduct.ingredients as any);

        const totalContent = updateProductDto.totalContent ?? currentProduct.totalContent;
        const portion = updateProductDto.portion ?? currentProduct.portion;

        ingredientContent = this.calculateIngredientContent(
          ingredientInputs,
          totalContent,
          portion,
        );
      }

      const { ingredients, brand, ...rest } = updateProductDto;
      const updateData: Record<string, unknown> = {
        ...rest,
      };

      if (ingredientContent) {
        updateData.ingredientContent = ingredientContent;
      }

      if (hasIngredientUpdates && ingredients) {
        updateData.ingredients = this.normalizeIngredients(ingredients as IngredientInput[]);
      }

      if (brand !== undefined) {
        updateData.brand = new Types.ObjectId(brand);
      }

      const product = await this.productModel
        .findByIdAndUpdate(id, updateData, { new: true })
        .populate([
          { path: 'brand', select: 'name status' },
          { path: 'ingredients.ingredient', select: 'name status' },
        ])
        .exec();
      if (!product) {
        throw new NotFoundException(`Product with ID ${id} not found`);
      }
      return this.buildProductResponse(product);
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
  ): Promise<ProductResponse[]> {
    // Validate main product exists and is a main product (not a comparable)
    const mainProduct = await this.productModel
      .findById(mainProductId)
      .populate('brand')
      .exec();

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

    // Validate that the main product is a Nutribiotics product
    const mainProductBrand = mainProduct.brand as any;
    if (mainProductBrand && mainProductBrand.name?.toUpperCase() !== 'NUTRABIOTICS') {
      throw new ConflictException(
        `Cannot add comparables to non-Nutrabiotics product. ` +
        `Main product brand: ${mainProductBrand.name}`,
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
          comparedTo: mainProduct._id,
        }),
      ),
    );

    return createdComparables;
  }

  async migrateIngredientContent(): Promise<void> {
    this.logger.log('Starting ingredient content migration...');

    // Find all products without ingredientContent
    const products = await this.productModel.find({
      $or: [
        { ingredientContent: { $exists: false } },
        { ingredientContent: null },
      ],
    }).exec();

    this.logger.log(`Found ${products.length} products to migrate`);

    let updated = 0;
    for (const product of products) {
      const ingredients = this.documentIngredientsToInputs(product.ingredients as any);

      const ingredientContent = this.calculateIngredientContent(
        ingredients,
        product.totalContent,
        product.portion,
      );

      await this.productModel.findByIdAndUpdate(
        product._id,
        { ingredientContent },
      ).exec();

      updated++;
    }

    this.logger.log(`Migration complete! Updated ${updated} products`);
  }

  async seedProducts(): Promise<void> {
    // We don't skip if products exist anymore, we check individually.
    this.logger.log(`Starting product seed check. Products data length: ${productsData.length}`);

    this.logger.log(`Products data length: ${productsData.length}`);
    try {
      let totalSeeded = 0;

      for (const productData of productsData as any[]) {
        try {
          const {
            comparables = [],
            brandName,
            ingredients: seedIngredients,
            ...mainProductData
          } = productData;

          const brandId = await this.resolveBrandIdByName(brandName);
          const ingredientInputs = await this.mapSeedIngredients(seedIngredients);

          if (ingredientInputs.length === 0) {
            this.logger.warn(`Skipping product "${mainProductData.name}" because it has no valid ingredients.`);
            continue;
          }

          // Check if main product already exists
          const existingProduct = await this.productModel.findOne({
            name: mainProductData.name,
            brand: brandId
          }).exec();

          let mainProduct: ProductDocument;

          if (existingProduct) {
            mainProduct = existingProduct;
          } else {
            const ingredientContent = this.calculateIngredientContent(
              ingredientInputs,
              mainProductData.totalContent,
              mainProductData.portion,
            );

            mainProduct = await this.productModel.create({
              ...mainProductData,
              brand: brandId,
              ingredients: this.normalizeIngredients(ingredientInputs),
              ingredientContent,
              comparedTo: null,
              status: 'active',
            });
            totalSeeded++;
            this.logger.log(`Created new product: ${mainProductData.name}`);
          }

          if (comparables && comparables.length > 0) {
            for (const comparable of comparables) {
              const {
                brandName: comparableBrandName,
                ingredients: comparableSeedIngredients,
                ...comparableData
              } = comparable;

              // Check if comparable already exists
              const comparableBrandId = await this.resolveBrandIdByName(comparableBrandName);
            
              const existingComparable = await this.productModel.findOne({
                name: comparableData.name,
                brand: comparableBrandId,
                comparedTo: mainProduct._id
              }).exec();

              if (existingComparable) {
                continue;
              }

              const comparableIngredientInputs = await this.mapSeedIngredients(comparableSeedIngredients);

              if (comparableIngredientInputs.length === 0) {
                this.logger.warn(`Skipping comparable "${comparable.name}" because it has no valid ingredients.`);
                continue;
              }

              const comparableIngredientContent = this.calculateIngredientContent(
                comparableIngredientInputs,
                comparable.totalContent,
                comparable.portion,
              );

              await this.productModel.create({
                ...comparableData,
                brand: comparableBrandId,
                ingredients: this.normalizeIngredients(comparableIngredientInputs),
                ingredientContent: comparableIngredientContent,
                comparedTo: mainProduct._id,
                status: 'active',
              });
              totalSeeded++;
            }
          }
        } catch (error) {
           const errorMessage = error instanceof Error ? error.message : String(error);
           this.logger.error(`Failed to seed product ${productData.name}: ${errorMessage}`);
        }
      }

      this.logger.log(`Seeding complete. Added ${totalSeeded} new products/comparables.`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error seeding products: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
    }
  }

  async processNutribioticsProducts(
    progressCallback?: (progress: number) => Promise<void>,
    productId?: string,
  ): Promise<{
    processed: number;
    newProducts: number;
    newIngredients: number;
    newBrands: number;
  }> {
    let processedCount = 0;
    let totalNewProducts = 0;
    let totalNewIngredients = 0;
    let totalNewBrands = 0;

    try {
      if (progressCallback) await progressCallback(10);

      const nutribioticsBrand = await this.brandModel
        .findOne({ name: { $regex: /^nutrabiotics$/i } })
        .exec();

      if (!nutribioticsBrand) {
        this.logger.warn('Nutribiotics brand not found. Skipping processing.');
        return {
          processed: 0,
          newProducts: 0,
          newIngredients: 0,
          newBrands: 0,
        };
      }

      const query: FilterQuery<ProductDocument> = {
        brand: nutribioticsBrand._id,
        comparedTo: null,
        status: 'active',
      };

      if (productId) {
        query._id = productId;

        // DEBUG: Check the product's actual status before applying the active filter
        const rawProduct = await this.productModel.findById(productId).exec();
        if (rawProduct) {
          this.logger.debug(`[DEBUG] Product ${productId}: name="${rawProduct.name}", status="${rawProduct.status}", brand="${rawProduct.brand}", comparedTo="${rawProduct.comparedTo}"`);
          if (rawProduct.status !== 'active') {
            this.logger.warn(`[DEBUG] Product ${productId} has status="${rawProduct.status}" — it will be EXCLUDED by the status:'active' filter`);
          }
          if (rawProduct.comparedTo != null) {
            this.logger.warn(`[DEBUG] Product ${productId} has comparedTo="${rawProduct.comparedTo}" — it will be EXCLUDED by the comparedTo:null filter (this is a comparable, not a base product)`);
          }
          if (rawProduct.brand?.toString() !== nutribioticsBrand._id.toString()) {
            this.logger.warn(`[DEBUG] Product ${productId} brand="${rawProduct.brand}" does not match Nutribiotics brand="${nutribioticsBrand._id}" — it will be EXCLUDED by the brand filter`);
          }
        } else {
          this.logger.warn(`[DEBUG] Product ${productId} does not exist in the database`);
        }
      }

      this.logger.debug(`[DEBUG] Final query: ${JSON.stringify(query)}`);

      const products = await this.productModel
        .find(query)
        .populate([
          { path: 'brand', select: 'name status' },
          { path: 'ingredients.ingredient', select: 'name measurementUnit status' },
        ])
        .exec();

      this.logger.debug(`Found ${products.length} Nutribiotics base products to process`);

      if (products.length === 0) {
        if (progressCallback) await progressCallback(100);
        return {
          processed: 0,
          newProducts: 0,
          newIngredients: 0,
          newBrands: 0,
        };
      }

      if (progressCallback) await progressCallback(15);

      // Use p-limit for concurrency control
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pLimit = require('p-limit');
      const limit = pLimit(20); // Process 20 products concurrently

      const processingPromises = products.map((product, i) =>
        limit(async () => {
        const baseProgress = 15;
        const progressPerProduct = 75 / products.length;
        const productStartProgress = baseProgress + (i * progressPerProduct);
        try {
          this.logger.debug(`Processing product: ${product.name} (${product._id})`);

        await this.productModel.findByIdAndUpdate(product._id, {
          scanStatus: 'running',
          lastScanDate: new Date(),
        });

        const [existingComparables, brandInfo, hydratedIngredients] = await Promise.all([
          this.productModel
            .find({ comparedTo: product._id })
            .populate({ path: 'brand', select: 'name status' })
            .exec(),
          this.hydrateBrand(product.brand as any),
          this.hydrateIngredients(product.ingredients as any),
        ]);

        this.logger.debug(`Found ${existingComparables.length} existing comparables for ${product.name}`);

       /* ─────────────────────────────────────────────
        * STEP 1 — SEARCH (FORCED GOOGLE SEARCH, URLs ONLY)
        * ───────────────────────────────────────────── */

        this.logger.debug(`Step 1: Searching for comparable products for ${product.name}`);

        // Get ingredient and brand details for the prompt
        const allIngredients = await this.ingredientModel.find().exec();
        const ingredientMap = new Map(allIngredients.map(i => [i.name, {name: i.name, measurementUnit: i.measurementUnit}]));
        const knownIngredientNames = new Set(
          allIngredients.map((ingredient) => ingredient.name.trim().toUpperCase()),
        );

        const allBrands = await this.brandModel.find().exec();
        const brandNames = allBrands.map(b => b.name);
        const knownBrandNames = new Set(allBrands.map((brand) => brand.name.trim().toUpperCase()));

        const brandName = brandInfo?.name || nutribioticsBrand.name;

        const ingredientsXml = hydratedIngredients
          .map((ingredientEntry) => {
            if (!ingredientEntry.name) {
              return null;
            }

            const ingredientDetails = ingredientMap.get(ingredientEntry.name) || {
              name: ingredientEntry.name,
              measurementUnit: 'MG',
            };

            const measurementUnit = ingredientDetails?.measurementUnit || 'MG';

            return `   <ingredient>
      <ingredientName>
        ${ingredientEntry.name}
      </ingredientName>
      <qty>${ingredientEntry.quantity ?? 'unknown'}</qty>
      <measurementUnit>${measurementUnit}</measurementUnit>
   </ingredient>`;
          })
          .filter((value): value is string => Boolean(value))
          .join('\n');

        const existingComparableSummaries = await Promise.all(
          existingComparables.map(async (p) => {
            const comparableBrand = await this.hydrateBrand(p.brand as any);
            return `- ${p.name} (${comparableBrand?.name || 'Unknown'})`;
          })
        );

        // Update progress: starting search for this product
        if (progressCallback) {
          await progressCallback(Math.round(productStartProgress + (progressPerProduct * 0.2)));
        }

        const prompt = `<instructions>
Search for comparable products available for purchase in ${COUNTRY} (Colombian online stores, pharmacies, retailers).

IMPORTANT: Only include products that are:
1. Actually available in ${COUNTRY} (not Mexico, Chile, or other countries)
2. Have similar ingredients and quantities to the reference product

If you cannot find specific products with detailed ingredient information, return an empty list rather than products from other countries.
</instructions>

<outputFormat>
Return a markdown table with these fields for each comparable product found in ${COUNTRY}:
- Product Name (without presentation details like "30 cápsulas")
- Brand
- Presentation (one of: cucharadas, cápsulas, tableta, softGel, gotas, sobre, vial, mililitro, push)
- totalContent (numeric value)
- totalContentUnit (unit like "ml", "g", "tablets")
- portion (numeric portion size)
- List of ingredients with: Ingredient Name, Quantity, Unit
IMPORTANT: Only include ingredients that have a known numeric quantity > 0. Omit ingredients like flavorings, colorants, or sweeteners if their quantity is unknown or zero.
</outputFormat>

<referenceProduct>
Name: ${product.name}
Brand: ${brandName}
Country: ${COUNTRY}
Ingredients:
${ingredientsXml}
</referenceProduct>

${existingComparableSummaries.length > 0 ? `<excludeProducts>
Do NOT include these already-known products:
${existingComparableSummaries.join('\n')}
</excludeProducts>` : ''}`;

        const { text, sources } = await generateText({
          model: google('gemini-3-pro-preview'),
          prompt,
          tools:{
            google_search: google.tools.googleSearch({})
          }
        });

        this.logger.debug(`Google response for ${product.name}:`);
        this.logger.debug(`Text: ${text}`);
        this.logger.debug(`Sources: ${JSON.stringify(sources, null, 2)}`);

        const { output } = await generateText({
          model: google('gemini-3-pro-preview'),
          output: Output.object({
            schema: z.object({
              newProducts: z.array(z.object({
                name: z.string().min(1),
                brand: z.string().min(1),
                ingredients: z.array(
                  z.object({
                    name: z.string().min(1),
                    qty: z.number().nonnegative(),
                    measurementUnit: z.enum(['MG', 'MCG', 'KCAL', 'UI', 'G', 'ML'] as const)
                  })
                ),
                totalContent: z.number().positive(),
                totalContentUnit: z.string().min(1).describe('Unit of measurement for totalContent (e.g., "ml", "g", "tablets")'),
                presentation: z.enum(Object.values(PresentationType) as [string, ...string[]]),
                portion: z.number().positive(),
              })),
              newIngredients: z.array(z.object({
                ingredientName: z.string(),
                measurementUnit: z.enum(['MG', 'MCG', 'KCAL', 'UI', 'G', 'ML'] as const),
              })),
              newBrands: z.array(z.object({
                brandName: z.string(),
              }))
            })
          }),
          prompt: `Here is the text containing the markdown table of comparable products you found for the product "${product.name}" by "${brandName}":
${text}

Extract the comparable products from the text.

For newIngredients: Compare the ingredients found in the products against this list of existing ingredients in the database:
${Array.from(ingredientMap.keys()).join(', ')}

If you find an ingredient that is NOT in the existing list, add it to newIngredients with its name and measurement unit. Only include ingredients that don't already exist in the database.

When filling the ingredients array for each newProducts entry, always try to reuse ingredient names from the existing list above (case-insensitive). If an ingredient already exists, use the exact existing name in newProducts so we avoid duplicates. Only invent a brand-new ingredient name when it genuinely is missing from the list, and whenever that happens you must also include it in newIngredients so both lists stay aligned.

For newBrands: Compare the brand names found in the products against this list of existing brands in the database:
${brandNames.join(', ')}

Use your judgment to determine if a brand is the same as an existing brand (considering variations in capitalization, spacing, or minor spelling differences). If you find a brand that is truly NEW and different from all existing brands, add it to newBrands. Only include brands that don't already exist in the database and that are actually the brand of any of the newProducts.`,
        })

        // Update progress: parsing results
        if (progressCallback) {
          await progressCallback(Math.round(productStartProgress + (progressPerProduct * 0.5)));
        }

        const { newProducts, newIngredients, newBrands } = output;

        this.logger.debug(`GPT-4o extraction results for ${product.name}:`);
        this.logger.debug(`New Products: ${JSON.stringify(newProducts, null, 2)}`);
        this.logger.debug(`New Ingredients: ${JSON.stringify(newIngredients, null, 2)}`);
        this.logger.debug(`New Brands: ${JSON.stringify(newBrands, null, 2)}`);

        const normalizeKey = (value: string) => value.trim().toUpperCase();
        const normalizeMeasurementUnit = (unit?: string): MeasurementUnit => {
          if (!unit) {
            return MeasurementUnit.MG;
          }
          const normalizedUnit = normalizeKey(unit) as MeasurementUnit;
          return (Object.values(MeasurementUnit) as string[]).includes(normalizedUnit)
            ? normalizedUnit
            : MeasurementUnit.MG;
        };

        const pendingIngredientsMap = new Map<string, { ingredientName: string; measurementUnit: MeasurementUnit }>();
        const pendingBrandsMap = new Map<string, { brandName: string }>();

        const registerIngredient = (name?: string, unit?: string) => {
          if (!name) {
            return;
          }
          const key = normalizeKey(name);
          if (knownIngredientNames.has(key) || pendingIngredientsMap.has(key)) {
            return;
          }
          pendingIngredientsMap.set(key, {
            ingredientName: key,
            measurementUnit: normalizeMeasurementUnit(unit),
          });
        };

        const registerBrand = (name?: string) => {
          if (!name) {
            return;
          }
          const key = normalizeKey(name);
          if (knownBrandNames.has(key) || pendingBrandsMap.has(key)) {
            return;
          }
          pendingBrandsMap.set(key, { brandName: key });
        };

        newIngredients.forEach((ingredient) =>
          registerIngredient(ingredient.ingredientName, ingredient.measurementUnit),
        );
        newBrands.forEach((brand) => registerBrand(brand.brandName));
        newProducts.forEach((candidate) => {
          registerBrand(candidate.brand);
          candidate.ingredients.forEach((ingredient) =>
            registerIngredient(ingredient.name, ingredient.measurementUnit),
          );
        });

        const dedupedNewIngredients = Array.from(pendingIngredientsMap.values());
        const dedupedNewBrands = Array.from(pendingBrandsMap.values());

        // Track counts for this product
        totalNewIngredients += dedupedNewIngredients.length;
        totalNewBrands += dedupedNewBrands.length;

        // Update progress: creating brands and ingredients
        if (progressCallback) {
          await progressCallback(Math.round(productStartProgress + (progressPerProduct * 0.7)));
        }

        // create new brands from newBrands
        for (const brand of dedupedNewBrands) {
          const existing = await this.brandModel
            .findOne({ name: { $regex: `^${brand.brandName}$`, $options: 'i' } })
            .exec();
          if (!existing) {
            this.logger.debug(`Creating new brand: ${brand.brandName}`);
            const newBrand = new this.brandModel({
              name: brand.brandName.toUpperCase(),
              status: ApprovalStatus.NOT_APPROVED,
            });
            await newBrand.save();
          }
        }

        // create new ingredients from newIngredients
        for (const ing of dedupedNewIngredients) {
          const existing = await this.ingredientModel.findOne({ name: ing.ingredientName }).exec();
          if (!existing) {
            this.logger.debug(`Creating new ingredient: ${ing.ingredientName}`);
            const newIng = new this.ingredientModel({
              name: ing.ingredientName.toUpperCase(),
              measurementUnit: ing.measurementUnit,
              status: ApprovalStatus.NOT_APPROVED,
            });
            await newIng.save();
          }
        }

        const pendingCreatedProductIds: string[] = [];

        // create new comparable products
        for (const p of newProducts) {
          this.logger.debug(`Creating new comparable product: ${p.name} (${p.brand})`);

          // Map ingredient names back to IDs
          const ingredientInputs: IngredientInput[] = [];
          for (const ing of p.ingredients) {
            const normalizedIngredientName = ing.name.trim();
            const ingDoc = await this.ingredientModel
              .findOne({ name: { $regex: `^${normalizedIngredientName}$`, $options: 'i' } })
              .exec();
            if (ingDoc) {
              ingredientInputs.push({ ingredientId: ingDoc._id.toString(), quantity: ing.qty });
            } else {
              this.logger.warn(`Ingredient not found for name: ${ing.name}. Skipping this ingredient.`);
            }
          }

          if (ingredientInputs.length === 0) {
            this.logger.warn(`Skipping comparable product "${p.name}" due to missing ingredient references.`);
            continue;
          }

          let comparableBrand = await this.brandModel
            .findOne({ name: { $regex: `^${p.brand}$`, $options: 'i' } })
            .exec();

          if (!comparableBrand) {
            this.logger.debug(`Creating new brand on the fly: ${p.brand}`);
            comparableBrand = await this.brandModel.create({
              name: p.brand.toUpperCase(),
              status: ApprovalStatus.NOT_APPROVED,
            });
          }

          const createdComparable = await this.create(
            {
              name: p.name,
              brand: comparableBrand._id.toString(),
              ingredients: ingredientInputs,
              totalContent: p.totalContent,
              presentation: p.presentation,
              portion: p.portion,
              comparedTo: product._id,
            },
            { status: 'inactive' },
          );

          if (createdComparable?.id) {
            pendingCreatedProductIds.push(createdComparable.id);
          }
        }

        // Track new products created
        totalNewProducts += pendingCreatedProductIds.length;

        if (pendingCreatedProductIds.length > 0) {
          await this.productModel.updateMany(
            { _id: { $in: pendingCreatedProductIds } },
            { status: 'inactive' },
          ).exec();
          this.logger.debug(
            `Marked ${pendingCreatedProductIds.length} auto-created comparables as inactive`,
          );
        }

        // Update progress: completed processing for this product
        if (progressCallback) {
          await progressCallback(Math.round(productStartProgress + progressPerProduct));
        }

        processedCount++;
        this.logger.debug(`Completed processing for product: ${product.name}`);
        } catch (error) {
          this.logger.error(`Error processing product ${product.name}:`, error);
          await this.productModel.findByIdAndUpdate(product._id, {
            scanStatus: 'failed',
          });
        }
      }));

      // Wait for all products to be processed
      await Promise.all(processingPromises);

      // Final progress update
      if (progressCallback) await progressCallback(95);

      this.logger.log(
        `Product discovery completed. Processed: ${processedCount}, ` +
        `New Products: ${totalNewProducts}, New Ingredients: ${totalNewIngredients}, ` +
        `New Brands: ${totalNewBrands}`,
      );

      return {
        processed: processedCount,
        newProducts: totalNewProducts,
        newIngredients: totalNewIngredients,
        newBrands: totalNewBrands,
      };
    } catch (error) {
      this.logger.error('Error in processNutribioticsProducts:', error);
      throw error;
    }
  }
}