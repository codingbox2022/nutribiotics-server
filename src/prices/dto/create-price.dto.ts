import { IsNotEmpty, IsNumber, IsString, Min, IsObject, IsOptional } from 'class-validator';

export class CreatePriceDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  precioSinIva?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  precioConIva?: number;

  @IsOptional()
  @IsObject()
  ingredientContent?: Record<string, number>;

  @IsOptional()
  @IsObject()
  pricePerIngredientContent?: Record<string, number>;

  @IsOptional()
  @IsString()
  marketplaceId?: string;

  @IsNotEmpty()
  @IsString()
  productId: string;

  @IsOptional()
  @IsString()
  ingestionRunId?: string;

  // Simple price update fields (for Nutribiotics products)
  @IsOptional()
  @IsNumber()
  @Min(0)
  value?: number;

  @IsOptional()
  @IsString()
  marketplace?: string;
}
