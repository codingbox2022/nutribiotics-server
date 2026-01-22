import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { ApprovalStatus } from '../../common/enums/approval-status.enum';

export enum MeasurementUnit {
  MG = 'mg',
  MCG = 'mcg',
  G = 'g',
  KG = 'kg',
  ML = 'ml',
  L = 'L',
  UFC = 'UFC',
  UI = 'UI',
  KCAL = 'kcal',
  PERCENT = '%',
}

export type IngredientDocument = HydratedDocument<Ingredient>;

@Schema({ timestamps: true })
export class Ingredient {
  @Prop({ required: true, unique: true })
  name: string;

  @Prop({ required: true, enum: MeasurementUnit })
  measurementUnit: string;

  @Prop({
    type: String,
    enum: Object.values(ApprovalStatus),
    default: ApprovalStatus.APPROVED
  })
  status: ApprovalStatus;
}

export const IngredientSchema = SchemaFactory.createForClass(Ingredient);
