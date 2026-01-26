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
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Types } from 'mongoose';
import { Capitalize } from '../../common/utils/capitalize.transformer';

export class ProductIngredientInputDto {
  @IsMongoId()
  ingredientId: string;

  @ValidateIf((o) => o.quantity !== null)
  @IsNumber()
  @Min(0.0001)
  quantity: number | null;
}

export class CreateProductDto {
  @Capitalize()
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
    'tabletas',
    'softgel',
    'gotas',
    'sobre',
    'vial',
    'mililitro',
    'push',
    'dosis',
    'ampollas',
    'gomas',
    'sticks',
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
