import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PriceDocument = HydratedDocument<Price>;

@Schema({ timestamps: true })
export class Price {
  @Prop({ required: true })
  value: number;

  @Prop({ required: true })
  marketplace: string;

  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;
}

export const PriceSchema = SchemaFactory.createForClass(Price);

PriceSchema.set('autoIndex', true);
PriceSchema.index({ productId: 1, marketplace: 1, createdAt: -1 });
