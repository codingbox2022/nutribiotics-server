import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsNumber,
  IsOptional,
  IsUrl,
  IsBoolean,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SearchCapabilitiesDto {
  @IsBoolean()
  @IsOptional()
  googleIndexedProducts?: boolean;
}

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

  @IsNumber()
  @Min(0)
  @IsOptional()
  productsScanned?: number;

  @IsBoolean()
  @IsOptional()
  seenByUser?: boolean;

  @IsOptional()
  searchCapabilities?: SearchCapabilitiesDto;
}
