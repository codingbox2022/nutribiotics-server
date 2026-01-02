import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { ApprovalStatus } from '../../common/enums/approval-status.enum';

export enum MeasurementUnit {
  MG = 'MG',
  MCG = 'MCG',
  KCAL = 'KCAL',
  UI = 'UI',
  G = 'G',
  ML = 'ML',
  UFC = 'UFC',
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
    default: ApprovalStatus.NOT_APPROVED
  })
  status: ApprovalStatus;
}

export const IngredientSchema = SchemaFactory.createForClass(Ingredient);
