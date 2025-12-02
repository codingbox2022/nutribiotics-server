import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsNumber,
  IsOptional,
  IsUrl,
  Min,
} from 'class-validator';

export class CreateMarketplaceDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  country: string;

  @IsUrl()
  @IsNotEmpty()
  baseUrl: string;

  @IsEnum(['active', 'inactive'])
  @IsOptional()
  status?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  productsScanned?: number;
}
