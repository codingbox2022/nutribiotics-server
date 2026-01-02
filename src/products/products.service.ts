import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { PresentationType, Product, ProductDocument } from './schemas/product.schema';
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

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(Ingredient.name) private ingredientModel: Model<IngredientDocument>,
    @InjectModel(Brand.name) private brandModel: Model<BrandDocument>,
    private pricesService: PricesService,
  ) {}

  private calculateIngredientContent(
    ingredients: Record<string, number>,
    totalContent: number,
    portion: number,
  ): Map<string, number> {
    const ingredientContent = new Map<string, number>();

    for (const [ingredientId, ingredientQty] of Object.entries(ingredients)) {
      // Ingredient Content = (totalContent × ingredient_quantity) ÷ portion
      const content = (totalContent * ingredientQty) / portion;
      ingredientContent.set(ingredientId, content);
    }

    return ingredientContent;
  }

  async create(createProductDto: CreateProductDto): Promise<ProductDocument> {
    try {
      // Calculate ingredient content
      const ingredientContent = this.calculateIngredientContent(
        createProductDto.ingredients,
        createProductDto.totalContent,
        createProductDto.portion,
      );

      const product = new this.productModel({
        ...createProductDto,
        ingredientContent,
      });
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
          comparedTo: mainProduct._id,
        }),
      ),
    );

    return { mainProduct, comparables };
  }

  private async populateIngredientNames(ingredientsMap: Map<string, number>): Promise<Record<string, number>> {
    if (!ingredientsMap || ingredientsMap.size === 0) {
      return {};
    }

    const ingredientKeys = Array.from(ingredientsMap.keys());

    // Check if keys are already names (not ObjectIds)
    // ObjectIds are 24 character hex strings
    const isObjectId = (str: string) => /^[0-9a-fA-F]{24}$/.test(str);
    const areKeysObjectIds = ingredientKeys.every(key => isObjectId(key));

    // If keys are already names, just return the map as an object
    if (!areKeysObjectIds) {
      const result: Record<string, number> = {};
      for (const [name, amount] of ingredientsMap.entries()) {
        result[name] = amount;
      }
      return result;
    }

    // Otherwise, populate names from IDs
    const ingredients = await this.ingredientModel.find({ _id: { $in: ingredientKeys } }).exec();

    const result: Record<string, number> = {};
    for (const [id, amount] of ingredientsMap.entries()) {
      const ingredient = ingredients.find(ing => ing._id.toString() === id);
      if (ingredient) {
        result[ingredient.name] = amount;
      }
    }

    return result;
  }

  async findPending(): Promise<any[]> {
    const pendingProducts = await this.productModel
      .find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .exec();

    const data = await Promise.all(
      pendingProducts.map(async (product) => {
        const [populatedIngredients, comparedToProduct, brand] = await Promise.all([
          this.populateIngredientNames(product.ingredients),
          product.comparedTo
            ? this.productModel.findById(product.comparedTo).exec()
            : null,
          this.brandModel.findOne({ name: product.brand }).exec(),
        ]);

        // Check for pending dependencies
        const ingredientIds = Array.from(product.ingredients.keys());
        const ingredients = await this.ingredientModel.find({
          _id: { $in: ingredientIds }
        }).exec();

        const pendingIngredientIds = ingredients
          .filter(ing => ing.status === 'not_approved')
          .map(ing => ing._id.toString());

        const pendingBrandIds = brand && brand.status === 'not_approved'
          ? [brand._id.toString()]
          : [];

        const productObj = product.toObject();

        return {
          ...productObj,
          ingredients: populatedIngredients,
          comparedToProduct: comparedToProduct ? {
            id: comparedToProduct._id.toString(),
            name: comparedToProduct.name,
            brand: comparedToProduct.brand,
          } : null,
          pendingIngredientIds,
          pendingBrandIds,
          hasPendingDependencies: pendingIngredientIds.length > 0 || pendingBrandIds.length > 0,
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
      this.productModel.find(query).skip(skip).limit(limit).exec(),
      this.productModel.countDocuments(query).exec(),
    ]);

    // For each original product, fetch its compared products and latest price
    const data = await Promise.all(
      originalProducts.map(async (product) => {
        const [comparedProducts, prices, populatedIngredients] = await Promise.all([
          this.productModel
            .find({ comparedTo: product._id })
            .exec(),
          this.pricesService.findAll({
            productId: product._id.toString(),
            limit: 1,
          }),
          this.populateIngredientNames(product.ingredients),
        ]);

        const latestPrice = prices.data.length > 0 ? prices.data[0].precioConIva : null;

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
      // Get current product to check if we need to recalculate ingredientContent
      const currentProduct = await this.productModel.findById(id).exec();
      if (!currentProduct) {
        throw new NotFoundException(`Product with ID ${id} not found`);
      }

      // Recalculate ingredient content if any related fields changed
      const shouldRecalculate =
        updateProductDto.ingredients ||
        updateProductDto.totalContent !== undefined ||
        updateProductDto.portion !== undefined;

      let ingredientContent: Map<string, number> | undefined;
      if (shouldRecalculate) {
        const ingredients = updateProductDto.ingredients ||
          (currentProduct.ingredients instanceof Map
            ? Object.fromEntries(currentProduct.ingredients)
            : currentProduct.ingredients);
        const totalContent = updateProductDto.totalContent ?? currentProduct.totalContent;
        const portion = updateProductDto.portion ?? currentProduct.portion;

        ingredientContent = this.calculateIngredientContent(
          ingredients,
          totalContent,
          portion,
        );
      }

      const updateData = shouldRecalculate
        ? { ...updateProductDto, ingredientContent }
        : updateProductDto;

      const product = await this.productModel
        .findByIdAndUpdate(id, updateData, { new: true })
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
          comparedTo: mainProduct._id,
        }),
      ),
    );

    return createdComparables;
  }

  async migrateIngredientContent(): Promise<void> {
    console.log('Starting ingredient content migration...');

    // Find all products without ingredientContent
    const products = await this.productModel.find({
      $or: [
        { ingredientContent: { $exists: false } },
        { ingredientContent: null },
      ],
    }).exec();

    console.log(`Found ${products.length} products to migrate`);

    let updated = 0;
    for (const product of products) {
      const ingredients = product.ingredients instanceof Map
        ? Object.fromEntries(product.ingredients)
        : product.ingredients;

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

    console.log(`Migration complete! Updated ${updated} products`);
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

        // Calculate ingredient content for main product
        const ingredientContent = this.calculateIngredientContent(
          mainProductData.ingredients,
          mainProductData.totalContent,
          mainProductData.portion,
        );

        const mainProduct = await this.productModel.create({
          ...mainProductData,
          ingredients: new Map(Object.entries(mainProductData.ingredients)),
          ingredientContent,
          comparedTo: null,
        });
        totalSeeded++;

        if (comparables && comparables.length > 0) {
          for (const comparable of comparables) {
            // Calculate ingredient content for comparable
            const comparableIngredientContent = this.calculateIngredientContent(
              comparable.ingredients,
              comparable.totalContent,
              comparable.portion,
            );

            await this.productModel.create({
              ...comparable,
              ingredients: new Map(Object.entries(comparable.ingredients)),
              ingredientContent: comparableIngredientContent,
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

  async processNutribioticsProducts(): Promise<void> {
    try {
      const products = await this.productModel.find({
        brand: { $regex: /^nutribiotics$/i },
        comparedTo: null,
      }).exec();

      this.logger.debug(`Found ${products.length} Nutribiotics base products to process`);

      for (const product of products) {
        try {
          this.logger.debug(`Processing product: ${product.name} (${product._id})`);

        await this.productModel.findByIdAndUpdate(product._id, {
          scanStatus: 'running',
          lastScanDate: new Date(),
        });

        const existingComparables = await this.productModel.find({
          comparedTo: product._id,
        });

        this.logger.debug(`Found ${existingComparables.length} existing comparables for ${product.name}`);

       /* ─────────────────────────────────────────────
        * STEP 1 — SEARCH (FORCED GOOGLE SEARCH, URLs ONLY)
        * ───────────────────────────────────────────── */

        this.logger.debug(`Step 1: Searching for comparable products for ${product.name}`);

        // Get ingredient and brand details for the prompt
        const allIngredients = await this.ingredientModel.find().exec();
        const ingredientMap = new Map(allIngredients.map(i => [i.name, {name: i.name, measurementUnit: i.measurementUnit}]));

        const allBrands = await this.brandModel.find().exec();
        const brandNames = allBrands.map(b => b.name);

        const productIngredients = product.ingredients instanceof Map
          ? Object.fromEntries(product.ingredients)
          : product.ingredients;

        const ingredientsXml = Object.entries(productIngredients)
          .map(([ingredientId, qty]) => {
            const ingredient = ingredientMap.get(ingredientId);
            const ingredientName = ingredient?.name || ingredientId;
            const measurementUnit = ingredient?.measurementUnit || 'MG';

            return `   <ingredient>
      <ingredientName>
        ${ingredientName}
      </ingredientName>
      <qty>${qty}</qty>
      <measurementUnit>${measurementUnit}</measurementUnit>
   </ingredient>`;
          })
          .join('\n');

        const prompt = `<instructions>
Given this product and its ingredients, I need you to look for comparable products in online stores available in the provided country. Use your own criteria to determine if a product is comparable based on the ingredients and their quantities.
</instructions>
<outputFormat>
You should retrieve a markdown table with the following fields for each comparable product you find:
- Product Name
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
   ${product.brand}
</brand>
<ingredients>
${ingredientsXml}
</ingredients>
<country>
   ${COUNTRY}
</country>

${existingComparables.length > 0 ? `<excludeProducts>
Neither the provided product or these products should be included in the list as they are already known:
${existingComparables.map(p => `- ${p.name} (${p.brand})`).join('\n')}
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
          prompt: `Here is the text containing the markdown table of comparable products you found for the product "${product.name}" by "${product.brand}":
${text}

Extract the comparable products from the text.

For newIngredients: Compare the ingredients found in the products against this list of existing ingredients in the database:
${Array.from(ingredientMap.keys()).join(', ')}

If you find an ingredient that is NOT in the existing list, add it to newIngredients with its name and measurement unit. Only include ingredients that don't already exist in the database.

For newBrands: Compare the brand names found in the products against this list of existing brands in the database:
${brandNames.join(', ')}

Use your judgment to determine if a brand is the same as an existing brand (considering variations in capitalization, spacing, or minor spelling differences). If you find a brand that is truly NEW and different from all existing brands, add it to newBrands. Only include brands that don't already exist in the database and that are actually the brand of any of the newProducts.`,
        })

        const { newProducts, newIngredients, newBrands } = output;

        console.dir({ newProducts, newIngredients, newBrands }, { depth: null });

        await fs.promises.writeFile(
          `temp/product_${product._id}_comparables.json`,
          JSON.stringify({text, sources, newProducts, newIngredients, newBrands }, null, 2),
        );

        // create new brands from newBrands
        for (const brand of newBrands) {
          const existing = await this.brandModel.findOne({ name: brand.brandName }).exec();
          if (!existing) {
            this.logger.debug(`Creating new brand: ${brand.brandName}`);
            const newBrand = new this.brandModel({
              name: brand.brandName.toUpperCase(),
            });
            await newBrand.save();
          }
        }

        // create new ingredients from newIngredients
        for (const ing of newIngredients) {
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

        // create new comparable products
        for (const p of newProducts) {
          this.logger.debug(`Creating new comparable product: ${p.name} (${p.brand})`);

          // Map ingredient names back to IDs
          const ingredientEntries: [string, number][] = [];
          for (const ing of p.ingredients) {
            const ingDoc = await this.ingredientModel.findOne({ name: ing.name }).exec();
            if (ingDoc) {
              ingredientEntries.push([ingDoc._id.toString(), ing.qty]);
            } else {
              this.logger.warn(`Ingredient not found for name: ${ing.name}. Skipping this ingredient.`);
            }
          }

          await this.create({
            name: p.name,
            brand: p.brand,
            ingredients: Object.fromEntries(ingredientEntries),
            totalContent: p.totalContent,
            presentation: p.presentation,
            portion: p.portion,
            comparedTo: product._id
          });
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