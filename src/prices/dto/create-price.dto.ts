import { IsNotEmpty, IsNumber, IsString, Min, IsObject } from 'class-validator';

export class CreatePriceDto {
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  precioSinIva: number;

  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  precioConIva: number;

  @IsNotEmpty()
  @IsObject()
  ingredientContent: Record<string, number>;

  @IsNotEmpty()
  @IsObject()
  pricePerIngredientContent: Record<string, number>;

  @IsNotEmpty()
  @IsString()
  marketplaceId: string;

  @IsNotEmpty()
  @IsString()
  productId: string;

  @IsNotEmpty()
  @IsString()
  ingestionRunId: string;
}
