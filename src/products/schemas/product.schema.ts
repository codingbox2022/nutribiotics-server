import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ProductDocument = HydratedDocument<Product>;

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  brand: string;

  @Prop({ type: Map, of: Number, required: true })
  ingredients: Map<string, number>;

  @Prop({ required: true })
  totalContent: number;

  @Prop({
    required: true,
    enum: [
      'cucharadas',
      'cápsulas',
      'tableta',
      'softGel',
      'gotas',
      'sobre',
      'vial',
      'mililitro',
      'push',
    ],
  })
  presentation: string;

  @Prop({ required: true })
  portion: number;

  @Prop()
  imageUrl: string;

  @Prop({ type: Types.ObjectId, ref: 'Product', default: null })
  comparedTo: Types.ObjectId;

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

ProductSchema.set('autoIndex', true);
ProductSchema.index({ name: 1, brand: 1 }, { unique: true });
