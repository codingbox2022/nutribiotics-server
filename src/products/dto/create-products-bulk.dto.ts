import { Type } from 'class-transformer';
import { IsArray, ValidateNested, ArrayMinSize } from 'class-validator';
import { CreateProductDto } from './create-product.dto';

export class CreateProductsBulkDto {
  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @Type(() => CreateProductDto)
  products: CreateProductDto[];
}
