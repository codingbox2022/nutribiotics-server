import { IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';

export class CreatePriceDto {
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  value: number;

  @IsNotEmpty()
  @IsString()
  marketplace: string;

  @IsNotEmpty()
  @IsString()
  productId: string;
}
