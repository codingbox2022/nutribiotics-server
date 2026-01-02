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
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { PaginatedResult } from '../common/interfaces/response.interface';
import { PricesService } from '../prices/prices.service';
import productsData from '../files/products.json';
import { generateText, generateObject, Output } from 'ai';
import z from 'zod';
import { openai } from '@ai-sdk/openai';
import fs from 'fs';

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
  quantity: number;
};

type IngredientDisplay = {
  id: string;
  name: string | null;
  quantity: number;
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
  ingredientQuantities: Record<string, number>;
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
  ): { ingredient: Types.ObjectId; quantity: number }[] {
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
  ): Record<string, number> {
    return ingredients.reduce<Record<string, number>>((acc, ingredient) => {
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
    seedIngredients: { name: string; quantity: number }[],
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

      acc.push({ ingredientId: id, quantity: ing.quantity });
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
      // Ingredient Content = (totalContent × ingredient_quantity) ÷ portion
      const content = (totalContent * quantity) / portion;
      ingredientContent.set(ingredientId, content);
    }

    return ingredientContent;
  }

  async create(
    createProductDto: CreateProductDto,
    options?: { status?: 'active' | 'suspended' | 'rejected' | 'pending' },
  ): Promise<ProductResponse> {
    try {
      const { ingredients, ...rest } = createProductDto;
      const status = options?.status ?? 'active';

      const ingredientContent = this.calculateIngredientContent(
        ingredients,
        createProductDto.totalContent,
        createProductDto.portion,
      );

      const normalizedIngredients = this.normalizeIngredients(ingredients);

      const product = new this.productModel({
        ...rest,
        ingredients: normalizedIngredients,
        ingredientContent,
        status,
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
          comparedTo: mainProduct._id,
        }),
      ),
    );

    return { mainProduct, comparables };
  }

  async findPending(): Promise<ProductResponse[]> {
    const pendingProducts = await this.productModel
      .find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .populate([
        { path: 'brand', select: 'name status' },
        { path: 'ingredients.ingredient', select: 'name status' },
      ])
      .exec();

    const data = await Promise.all(
      pendingProducts.map(async (product) => {
        const [productPayload, comparedToProduct] = await Promise.all([
          this.buildProductResponse(product),
          product.comparedTo
            ? this.productModel
                .findById(product.comparedTo)
                .populate({ path: 'brand', select: 'name status' })
                .exec()
            : Promise.resolve(null),
        ]);

        const pendingIngredientIds = (product.ingredients || [])
          .map((entry) => {
            const ref: any = entry.ingredient;
            const status = ref?.status;
            if (status === 'not_approved') {
              if (ref?._id) {
                return ref._id.toString();
              }
              if (ref instanceof Types.ObjectId || typeof ref === 'string') {
                return ref.toString();
              }
            }
            return null;
          })
          .filter((value): value is string => Boolean(value));

        const pendingBrandIds = (() => {
          const brandRef: any = product.brand;
          const status = brandRef?.status;
          if (status === 'not_approved') {
            if (brandRef?._id) {
              return [brandRef._id.toString()];
            }
            if (brandRef instanceof Types.ObjectId || typeof brandRef === 'string') {
              return [brandRef.toString()];
            }
          }
          return [];
        })();

        return {
          ...productPayload,
          comparesTo: comparedToProduct
            ? {
                id: comparedToProduct._id.toString(),
                name: comparedToProduct.name,
                brand: await this.hydrateBrand(comparedToProduct.brand as any),
              }
            : null,
          pendingIngredientIds,
          pendingBrandIds,
          hasPendingDependencies:
            pendingIngredientIds.length > 0 || pendingBrandIds.length > 0,
        };
      }),
    );

    return data;
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
      this.productModel
        .find(query)
        .skip(skip)
        .limit(limit)
        .populate([
          { path: 'brand', select: 'name status' },
          { path: 'ingredients.ingredient', select: 'name status' },
        ])
        .exec(),
      this.productModel.countDocuments(query).exec(),
    ]);

    // For each original product, fetch its compared products and latest price
    const data = await Promise.all(
      originalProducts.map(async (product) => {
        const [comparedProducts, prices, baseProduct] = await Promise.all([
          this.productModel
            .find({ comparedTo: product._id })
            .populate([
              { path: 'brand', select: 'name status' },
              { path: 'ingredients.ingredient', select: 'name status' },
            ])
            .exec(),
          this.pricesService.findAll({
            productId: product._id.toString(),
            limit: 1,
          }),
          this.buildProductResponse(product),
        ]);

        const latestPrice = prices.data.length > 0 ? prices.data[0].precioConIva : null;

        const comparedProductsWithIngredients = await Promise.all(
          comparedProducts.map((p) => this.buildProductResponse(p)),
        );

        return {
          ...baseProduct,
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

      const { ingredients, ...rest } = updateProductDto;
      const updateData: Record<string, unknown> = {
        ...rest,
      };

      if (ingredientContent) {
        updateData.ingredientContent = ingredientContent;
      }

      if (hasIngredientUpdates && ingredients) {
        updateData.ingredients = this.normalizeIngredients(ingredients as IngredientInput[]);
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
    const count = await this.productModel.countDocuments().exec();
    this.logger.log(`Current product count: ${count}`);
    if (count > 0) {
      this.logger.log('Products already seeded');
      return;
    }

    this.logger.log(`Products data length: ${productsData.length}`);
    try {
      let totalSeeded = 0;

      for (const productData of productsData as any[]) {
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

        const ingredientContent = this.calculateIngredientContent(
          ingredientInputs,
          mainProductData.totalContent,
          mainProductData.portion,
        );

        const mainProduct = await this.productModel.create({
          ...mainProductData,
          brand: brandId,
          ingredients: this.normalizeIngredients(ingredientInputs),
          ingredientContent,
          comparedTo: null,
          status: 'active',
        });
        totalSeeded++;

        if (comparables && comparables.length > 0) {
          for (const comparable of comparables) {
            const {
              brandName: comparableBrandName,
              ingredients: comparableSeedIngredients,
              ...comparableData
            } = comparable;

            const comparableBrandId = await this.resolveBrandIdByName(comparableBrandName);
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
      }

      this.logger.log(`Seeded ${totalSeeded} products (${productsData.length} main + comparables)`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error seeding products: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
    }
  }

  async processNutribioticsProducts(): Promise<void> {
    try {
      const nutribioticsBrand = await this.brandModel
        .findOne({ name: { $regex: /^nutribiotics$/i } })
        .exec();

      if (!nutribioticsBrand) {
        this.logger.warn('Nutribiotics brand not found. Skipping processing.');
        return;
      }

      const products = await this.productModel
        .find({
          brand: nutribioticsBrand._id,
          comparedTo: null,
        })
        .populate([
          { path: 'brand', select: 'name status' },
          { path: 'ingredients.ingredient', select: 'name measurementUnit status' },
        ])
        .exec();

      this.logger.debug(`Found ${products.length} Nutribiotics base products to process`);

      for (const product of products) {
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
      <qty>${ingredientEntry.quantity}</qty>
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

        const prompt = `<instructions>
Given this product and its ingredients, I need you to look for comparable products in online stores available in the provided country. Use your own criteria to determine if a product is comparable based on the ingredients and their quantities.
</instructions>
<outputFormat>
You should retrieve a markdown table with the following fields for each comparable product you find:
- Product Name (The product name should not include presentation details like quantities or "cápsulas", "tabletas", etc.)
- Brand 
- Presentation (must be one of: cucharadas, cápsulas, tableta, softGel, gotas, sobre, vial, mililitro, push)
- totalContent (numeric value representing the total content in the package)
- totalContentUnit (the unit of measurement for totalContent, e.g., "ml", "g", "tablets", etc.)
- portion (numeric value representing the portion size)

- A list of ingredients with the following details for each ingredient:
- Ingredient Name
- Quantity
- Unit
</outputFormat>

<productName>
   ${product.name}
</productName>
<brand>
  ${brandName}
</brand>
<ingredients>
${ingredientsXml}
</ingredients>
<country>
   ${COUNTRY}
</country>

${existingComparableSummaries.length > 0 ? `<excludeProducts>
Neither the provided product or these products should be included in the list as they are already known:
${existingComparableSummaries.join('\n')}
</excludeProducts>` : ''}`;

        const { text, sources } = await generateText({
          model: openai('gpt-5.2'),
          tools: {
            web_search: openai.tools.webSearch({}),
          },
          prompt,
        });

        const { output } = await generateText({
          model: openai('gpt-4o'),
          output: Output.object({
            schema: z.object({
              newProducts: z.array(z.object({
                name: z.string().min(1),
                brand: z.string().min(1),
                ingredients: z.array(
                  z.object({
                    name: z.string().min(1),
                    qty: z.number().positive(),
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

        const { newProducts, newIngredients, newBrands } = output;

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

        await fs.promises.writeFile(
          `temp/product_${product._id}_comparables.json`,
          JSON.stringify({text, sources, newProducts, newIngredients: dedupedNewIngredients, newBrands: dedupedNewBrands }, null, 2),
        );

        // create new brands from newBrands
        for (const brand of dedupedNewBrands) {
          const existing = await this.brandModel
            .findOne({ name: { $regex: `^${brand.brandName}$`, $options: 'i' } })
            .exec();
          if (!existing) {
            this.logger.debug(`Creating new brand: ${brand.brandName}`);
            const newBrand = new this.brandModel({
              name: brand.brandName.toUpperCase(),
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
              name: ing.ingredientName,
              measurementUnit: ing.measurementUnit,
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
            { status: 'pending' },
          );

          if (createdComparable?.id) {
            pendingCreatedProductIds.push(createdComparable.id);
          }
        }

        if (pendingCreatedProductIds.length > 0) {
          await this.productModel.updateMany(
            { _id: { $in: pendingCreatedProductIds } },
            { status: 'pending' },
          ).exec();
          this.logger.debug(
            `Marked ${pendingCreatedProductIds.length} auto-created comparables as pending`,
          );
        }
        this.logger.debug(`Completed processing for product: ${product.name}`);
        } catch (error) {
          this.logger.error(`Error processing product ${product.name}:`, error);
          await this.productModel.findByIdAndUpdate(product._id, {
            scanStatus: 'failed',
          });
        }
      }
    } catch (error) {
      this.logger.error('Error in processNutribioticsProducts:', error);
      throw error;
    }
  }
}