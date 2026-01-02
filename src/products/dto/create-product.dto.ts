import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsEnum,
  IsOptional,
  IsMongoId,
  IsObject,
  Min,
} from 'class-validator';
import mongoose, { mongo } from 'mongoose';

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  brand: string;

  @IsObject()
  @IsNotEmpty()
  ingredients: Record<string, number>;

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
  comparedTo?: mongoose.Types.ObjectId;

  @IsEnum(['ok', 'alert', 'opportunity'])
  @IsOptional()
  alertLevel?: string;
}
