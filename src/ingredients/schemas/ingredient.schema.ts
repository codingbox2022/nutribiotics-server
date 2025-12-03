import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type IngredientDocument = HydratedDocument<Ingredient>;

@Schema({ timestamps: true })
export class Ingredient {
  @Prop({ required: true, unique: true })
  name: string;

  @Prop({ required: true })
  measurementUnit: string;
}

export const IngredientSchema = SchemaFactory.createForClass(Ingredient);
