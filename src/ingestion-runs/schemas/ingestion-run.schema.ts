import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type IngestionRunDocument = IngestionRun & Document;

export class LookupResult {
  @Prop({ type: Types.ObjectId, required: true })
  productId: Types.ObjectId;

  @Prop({ required: true })
  productName: string;

  @Prop({ type: Types.ObjectId, required: true })
  marketplaceId: Types.ObjectId;

  @Prop({ required: true })
  marketplaceName: string;

  @Prop({ required: true })
  url: string;

  @Prop()
  price?: number;

  @Prop({ type: Number })
  precioSinIva?: number;

  @Prop({ type: Boolean })
  precioSinIvaCalculated?: boolean;

  @Prop({ type: Number })
  precioConIva?: number;

  @Prop({ type: Number })
  ivaRate?: number;

  @Prop()
  country?: string;

  @Prop({ type: Object })
  ingredientContent?: Record<string, number>;

  @Prop({ type: Object })
  pricePerIngredientContent?: Record<string, number>;

  @Prop()
  currency?: string;

  @Prop()
  inStock?: boolean;

  @Prop({ type: Date, required: true })
  scrapedAt: Date;

  @Prop({
    required: true,
    enum: ['success', 'not_found', 'error'],
  })
  lookupStatus: string;

  @Prop()
  errorMessage?: string;
}

@Schema({ timestamps: true })
export class IngestionRun {
  @Prop({
    required: true,
    enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
    default: 'pending',
  })
  status: string;

  @Prop({ required: true })
  triggeredBy: string;

  @Prop({ type: Date, required: true, default: Date.now })
  triggeredAt: Date;

  @Prop({ type: Date })
  startedAt?: Date;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ required: true, default: 0 })
  totalProducts: number;

  @Prop({ required: true, default: 0 })
  processedProducts: number;

  @Prop({ required: true, default: 0 })
  totalLookups: number;

  @Prop({ required: true, default: 0 })
  completedLookups: number;

  @Prop({ required: true, default: 0 })
  failedLookups: number;

  @Prop({ type: [Object], default: [] })
  results: LookupResult[];

  @Prop({ default: 0 })
  productsWithPrices?: number;

  @Prop({ default: 0 })
  productsNotFound?: number;

  @Prop()
  errorMessage?: string;

  @Prop()
  errorStack?: string;

  @Prop({ type: Date })
  failedAt?: Date;
}

export const IngestionRunSchema = SchemaFactory.createForClass(IngestionRun);
