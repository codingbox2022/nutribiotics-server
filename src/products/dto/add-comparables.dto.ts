import { IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateProductDto } from './create-product.dto';

export class AddComparablesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateProductDto)
  comparables: CreateProductDto[];
}
