import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsEnum,
  IsOptional,
  IsMongoId,
  Min,
  IsArray,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Types } from 'mongoose';

export class ProductIngredientInputDto {
  @IsMongoId()
  ingredientId: string;

  @IsNumber()
  @Min(0.0001)
  quantity: number;
}

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsMongoId()
  brand: string;

  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @Type(() => ProductIngredientInputDto)
  ingredients: ProductIngredientInputDto[];

  @IsNumber()
  @Min(1)
  totalContent: number;

  @IsEnum([
    'cucharadas',
    'cápsulas',
    'tableta',
    'softGel',
    'gotas',
    'sobre',
    'vial',
    'mililitro',
    'push',
  ])
  presentation: string;

  @IsNumber()
  @Min(1)
  portion: number;

  @IsString()
  @IsOptional()
  imageUrl?: string;

  @IsMongoId()
  @IsOptional()
  comparedTo?: Types.ObjectId;

  @IsEnum(['ok', 'alert', 'opportunity'])
  @IsOptional()
  alertLevel?: string;
}
