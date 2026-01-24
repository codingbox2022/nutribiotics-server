import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PriceHistoryDocument = HydratedDocument<PriceHistory>;

@Schema({ timestamps: true })
export class PriceHistory {
  @Prop({ type: Types.ObjectId, ref: 'Price', required: true })
  priceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ required: true })
  oldPrecioConIva: number;

  @Prop({ required: true })
  newPrecioConIva: number;

  @Prop({ required: true })
  oldPrecioSinIva: number;

  @Prop({ required: true })
  newPrecioSinIva: number;

  @Prop({ required: true })
  changeReason: string; // e.g., 'recommendation_accepted', 'recommendation_rejected', 'manual_update'

  @Prop({ required: false })
  recommendation?: string; // 'raise', 'lower', 'keep'

  @Prop({ required: false })
  recommendedPrice?: number;

  @Prop({ required: false })
  recommendationReasoning?: string;

  @Prop({ required: false })
  changedBy?: string; // user email or id

  @Prop({ required: false })
  notes?: string;
}

export const PriceHistorySchema = SchemaFactory.createForClass(PriceHistory);

PriceHistorySchema.index({ priceId: 1, createdAt: -1 });
PriceHistorySchema.index({ productId: 1, createdAt: -1 });
