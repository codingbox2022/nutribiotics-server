import { PartialType } from '@nestjs/mapped-types';
import { IsEnum, IsOptional } from 'class-validator';
import { CreateProductDto } from './create-product.dto';

export class UpdateProductDto extends PartialType(CreateProductDto) {
  @IsEnum(['active', 'inactive', 'rejected', 'deleted'])
  @IsOptional()
  status?: string;
}
