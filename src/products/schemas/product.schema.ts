import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ProductDocument = HydratedDocument<Product>;

export enum PresentationType {
  cucharadas = 'cucharadas',
  capsulas = 'cápsulas',
  tableta = 'tableta',
  softGel = 'softGel',
  gotas = 'gotas',
  sobre  = 'sobre',
  vial = 'vial',
  mililitro = 'mililitro',
  push = 'push',
}

@Schema({ _id: false })
export class ProductIngredient {
  @Prop({ type: Types.ObjectId, ref: 'Ingredient', required: true })
  ingredient: Types.ObjectId;

  @Prop({ type: Number, required: true })
  quantity: number;
}

export const ProductIngredientSchema = SchemaFactory.createForClass(ProductIngredient);

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true })
  name: string;

  @Prop({ type: Types.ObjectId, ref: 'Brand', required: true })
  brand: Types.ObjectId;

  @Prop({ type: [ProductIngredientSchema], required: true })
  ingredients: ProductIngredient[];

  @Prop({ required: true })
  totalContent: number;

  @Prop({
    required: true,
    enum: PresentationType,
  })
  presentation: string;

  @Prop({ required: true })
  portion: number;

  @Prop({ type: Map, of: Number })
  ingredientContent: Map<string, number>;

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

  @Prop({
    enum: ['active', 'inactive', 'rejected', 'deleted'],
    default: 'inactive',
  })
  status: string;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

ProductSchema.set('autoIndex', true);
ProductSchema.set('toJSON', {
  transform: function(doc, ret) {
    if (ret.ingredientContent && ret.ingredientContent instanceof Map) {
      ret.ingredientContent = Object.fromEntries(ret.ingredientContent) as any;
    }
    return ret;
  }
});
ProductSchema.set('toObject', {
  transform: function(doc, ret) {
    if (ret.ingredientContent && ret.ingredientContent instanceof Map) {
      ret.ingredientContent = Object.fromEntries(ret.ingredientContent) as any;
    }
    return ret;
  }
});
ProductSchema.index({ name: 1, brand: 1 }, { unique: true });
ProductSchema.index({ comparedTo: 1 });
// Compound index for competitor queries that filter by comparedTo and brand
ProductSchema.index({ comparedTo: 1, brand: 1 });
// Index for status-based queries
ProductSchema.index({ status: 1, createdAt: -1 });
