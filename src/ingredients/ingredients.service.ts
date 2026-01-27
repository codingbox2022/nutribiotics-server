import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { Ingredient, IngredientDocument } from './schemas/ingredient.schema';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { PaginatedResult } from '../common/interfaces/response.interface';
import ingredientsData from '../files/ingredients.json';
import { ApprovalStatus } from '../common/enums/approval-status.enum';

interface FindAllFilters {
  search?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class IngredientsService {
  private readonly logger = new Logger(IngredientsService.name);

  constructor(
    @InjectModel(Ingredient.name)
    private ingredientModel: Model<IngredientDocument>,
  ) {}

  async create(
    createIngredientDto: CreateIngredientDto,
  ): Promise<IngredientDocument> {
    const ingredient = new this.ingredientModel(createIngredientDto);
    return ingredient.save();
  }

  async findAll(
    filters: FindAllFilters,
  ): Promise<PaginatedResult<IngredientDocument>> {
    const { page = 1, limit = 10, search } = filters;
    const query: FilterQuery<IngredientDocument> = {};

    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.ingredientModel.find(query).skip(skip).limit(limit).exec(),
      this.ingredientModel.countDocuments(query).exec(),
    ]);

    return {
      data,
      meta: { page, limit, total },
    };
  }

  async findOne(id: string): Promise<IngredientDocument> {
    const ingredient = await this.ingredientModel.findById(id).exec();
    if (!ingredient) {
      throw new NotFoundException(`Ingredient with ID ${id} not found`);
    }
    return ingredient;
  }

  async update(
    id: string,
    updateIngredientDto: UpdateIngredientDto,
  ): Promise<IngredientDocument> {
    const ingredient = await this.ingredientModel
      .findByIdAndUpdate(id, updateIngredientDto, { new: true })
      .exec();
    if (!ingredient) {
      throw new NotFoundException(`Ingredient with ID ${id} not found`);
    }
    return ingredient;
  }

  async remove(id: string): Promise<void> {
    const result = await this.ingredientModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`Ingredient with ID ${id} not found`);
    }
  }

  async seedIngredients(): Promise<void> {
    this.logger.log(`Checking ingredients seed data...`);
    
    // Normalize data from JSON
    const normalizedData = ingredientsData.map((ingredient) => ({
      ...ingredient,
      name: ingredient.name.toUpperCase(),
      status: ApprovalStatus.APPROVED,
    }));

    // Get all existing ingredient names to minimize DB queries
    const existingIngredients = await this.ingredientModel
      .find({}, { name: 1 })
      .lean()
      .exec();
    
    const existingNames = new Set(existingIngredients.map(i => i.name));
    const newIngredients = normalizedData.filter(i => !existingNames.has(i.name));

    if (newIngredients.length === 0) {
      this.logger.log('All ingredients already seeded');
      return;
    }

    this.logger.log(`Found ${newIngredients.length} new ingredients to seed`);

    try {
      await this.ingredientModel.insertMany(newIngredients);
      this.logger.log(`Seeded ${newIngredients.length} new ingredients`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error seeding ingredients: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
    }
  }

  async findPending(): Promise<IngredientDocument[]> {
    return this.ingredientModel
      .find({ status: ApprovalStatus.NOT_APPROVED })
      .exec();
  }

  async acceptPending(id: string, name: string): Promise<IngredientDocument> {
    const ingredient = await this.ingredientModel
      .findByIdAndUpdate(
        id,
        { name: name.toUpperCase(), status: ApprovalStatus.APPROVED },
        { new: true },
      )
      .exec();
    if (!ingredient) {
      throw new NotFoundException(`Ingredient with ID ${id} not found`);
    }
    return ingredient;
  }

  async rejectPending(id: string): Promise<void> {
    const result = await this.ingredientModel
      .findByIdAndUpdate(id, { status: ApprovalStatus.REJECTED }, { new: true })
      .exec();
    if (!result) {
      throw new NotFoundException(`Ingredient with ID ${id} not found`);
    }
  }
}
