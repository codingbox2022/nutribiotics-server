import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MarketplaceDocument = HydratedDocument<Marketplace>;

@Schema({ timestamps: true })
export class Marketplace {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  country: string;

  @Prop({ required: true, type: Number, default: 0.19 })
  ivaRate: number;

  @Prop({ required: true })
  baseUrl: string;

  @Prop({ enum: ['active', 'inactive'], default: 'active' })
  status: string;

  @Prop({ default: 0 })
  productsScanned: number;

  @Prop({ default: null })
  lastScanDate: Date;
}

export const MarketplaceSchema = SchemaFactory.createForClass(Marketplace);
