import { IsString, IsNotEmpty } from 'class-validator';
import { Capitalize } from '../../common/utils/capitalize.transformer';

export class CreateBrandDto {
  @Capitalize()
  @IsString()
  @IsNotEmpty()
  name: string;
}
