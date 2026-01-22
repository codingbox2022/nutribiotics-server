import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PriceDocument = HydratedDocument<Price>;

@Schema({ timestamps: true })
export class Price {
  @Prop({ required: true })
  precioSinIva: number;

  @Prop({ required: true })
  precioConIva: number;

  @Prop({ type: Map, of: Number, required: true })
  ingredientContent: Map<string, number>;

  @Prop({ type: Map, of: Number, required: true })
  pricePerIngredientContent: Map<string, number>;

  @Prop({ type: Types.ObjectId, ref: 'Marketplace', required: false })
  marketplaceId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'IngestionRun', required: false })
  ingestionRunId?: Types.ObjectId;

  @Prop({ type: Number, min: 0, max: 1, required: false })
  priceConfidence?: number;

  @Prop({ enum: ['raise', 'lower', 'keep'], required: false })
  recommendation?: string;

  @Prop({ required: false })
  recommendationReasoning?: string;

  @Prop({ required: false })
  recommendedPrice?: number;
}

export const PriceSchema = SchemaFactory.createForClass(Price);

PriceSchema.set('autoIndex', true);
PriceSchema.set('toJSON', {
  transform: function(doc, ret) {
    if (ret.ingredientContent && ret.ingredientContent instanceof Map) {
      ret.ingredientContent = Object.fromEntries(ret.ingredientContent) as any;
    }
    if (ret.pricePerIngredientContent && ret.pricePerIngredientContent instanceof Map) {
      ret.pricePerIngredientContent = Object.fromEntries(ret.pricePerIngredientContent) as any;
    }
    return ret;
  }
});
PriceSchema.set('toObject', {
  transform: function(doc, ret) {
    if (ret.ingredientContent && ret.ingredientContent instanceof Map) {
      ret.ingredientContent = Object.fromEntries(ret.ingredientContent) as any;
    }
    if (ret.pricePerIngredientContent && ret.pricePerIngredientContent instanceof Map) {
      ret.pricePerIngredientContent = Object.fromEntries(ret.pricePerIngredientContent) as any;
    }
    return ret;
  }
});
PriceSchema.index({ productId: 1, marketplaceId: 1, createdAt: -1 });
