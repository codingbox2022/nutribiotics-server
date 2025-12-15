import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PriceDocument = HydratedDocument<Price>;

@Schema({ timestamps: true })
export class Price {
  @Prop({ required: true })
  precioSinIva: number;

  @Prop({ required: true })
  precioConIva: number;

  @Prop({ type: Types.ObjectId, ref: 'Marketplace', required: true })
  marketplaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'IngestionRun', required: true })
  ingestionRunId: Types.ObjectId;
}

export const PriceSchema = SchemaFactory.createForClass(Price);

PriceSchema.set('autoIndex', true);
PriceSchema.index({ productId: 1, marketplaceId: 1, createdAt: -1 });
