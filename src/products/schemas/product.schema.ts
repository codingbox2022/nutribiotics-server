import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProductDocument = HydratedDocument<Product>;

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true, unique: true })
  sku: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  line: string;

  @Prop({ default: 'Core' })
  segment: string;

  @Prop({
    required: true,
    enum: ['capsules', 'sachets', 'ml', 'tablets', 'powder'],
  })
  form: string;

  @Prop({ required: true })
  packSize: number;

  @Prop({ required: true })
  concentration: string;

  @Prop({ required: true })
  priceWithTax: number;

  @Prop({ required: true })
  priceWithoutTax: number;

  @Prop()
  unitPrice: number;

  @Prop()
  unitType: string;

  @Prop({
    enum: ['increase', 'decrease', 'maintain', 'promo'],
    default: 'maintain',
  })
  recommendation: string;

  @Prop({ default: '' })
  recommendationRationale: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: [String], default: [] })
  ingredients: string[];

  @Prop({ enum: ['ok', 'alert', 'opportunity'], default: 'ok' })
  alertLevel: string;

  @Prop({ default: null })
  lastScanDate: Date;

  @Prop({
    enum: ['not_started', 'running', 'completed', 'error'],
    default: 'not_started',
  })
  scanStatus: string;
}

export const ProductSchema = SchemaFactory.createForClass(Product);
