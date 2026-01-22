import { IsString, IsNotEmpty } from 'class-validator';
import { Capitalize } from '../../common/utils/capitalize.transformer';

export class CreateIngredientDto {
  @Capitalize()
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  measurementUnit: string;
}
