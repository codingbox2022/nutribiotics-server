import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsNumber,
  IsOptional,
  IsUrl,
  IsBoolean,
  Min,
} from 'class-validator';

export class CreateMarketplaceDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  country: string;

  @IsNumber()
  @IsNotEmpty()
  @Min(0)
  ivaRate: number;

  @IsUrl()
  @IsNotEmpty()
  baseUrl: string;

  @IsEnum(['active', 'inactive'])
  @IsOptional()
  status?: string;

  @IsEnum(['search', 'browser'])
  @IsOptional()
  scanStrategy?: string;

  @IsString()
  @IsOptional()
  browserSetup?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  productsScanned?: number;

  @IsBoolean()
  @IsOptional()
  seenByUser?: boolean;
}
