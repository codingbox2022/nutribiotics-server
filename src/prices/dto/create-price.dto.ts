import { IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';

export class CreatePriceDto {
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  value: number;

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
