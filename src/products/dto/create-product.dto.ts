import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsEnum,
  IsArray,
  IsOptional,
  Min,
} from 'class-validator';

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  sku: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  line: string;

  @IsString()
  @IsOptional()
  segment?: string;

  @IsEnum(['capsules', 'sachets', 'ml', 'tablets', 'powder'])
  form: string;

  @IsNumber()
  @Min(1)
  packSize: number;

  @IsString()
  @IsNotEmpty()
  concentration: string;

  @IsNumber()
  @Min(0)
  priceWithTax: number;

  @IsNumber()
  @Min(0)
  priceWithoutTax: number;

  @IsNumber()
  @IsOptional()
  unitPrice?: number;

  @IsString()
  @IsOptional()
  unitType?: string;

  @IsEnum(['increase', 'decrease', 'maintain', 'promo'])
  @IsOptional()
  recommendation?: string;

  @IsString()
  @IsOptional()
  recommendationRationale?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  ingredients?: string[];

  @IsEnum(['ok', 'alert', 'opportunity'])
  @IsOptional()
  alertLevel?: string;
}
