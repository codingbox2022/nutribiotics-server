import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { Ingredient, IngredientDocument } from './schemas/ingredient.schema';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { PaginatedResult } from '../common/interfaces/response.interface';
import ingredientsData from '../files/ingredients.json';

interface FindAllFilters {
  search?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class IngredientsService {
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
    const count = await this.ingredientModel.countDocuments().exec();
    console.log(`Current ingredient count: ${count}`);
    if (count > 0) {
      console.log('Ingredients already seeded');
      return;
    }

    console.log(`Ingredients data length: ${ingredientsData.length}`);
    try {
      await this.ingredientModel.insertMany(ingredientsData);
      console.log(`Seeded ${ingredientsData.length} ingredients`);
    } catch (error) {
      console.error('Error seeding ingredients:', error);
    }
  }
}
