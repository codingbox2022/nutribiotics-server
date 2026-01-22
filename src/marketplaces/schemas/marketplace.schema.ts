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

  @Prop({ enum: ['active', 'inactive', 'rejected'], default: 'active' })
  status: string;

  @Prop({ type: String, required: false })
  rejectionReason?: string;

  @Prop({
    type: {
      googleIndexedProducts: { type: Boolean, default: false },
    },
    default: () => ({ googleIndexedProducts: false }),
  })
  searchCapabilities: {
    googleIndexedProducts: boolean;
  };

  @Prop({ default: 0 })
  productsScanned: number;

  @Prop({ default: null })
  lastScanDate: Date;

  @Prop({ default: false })
  seenByUser: boolean;
}

export const MarketplaceSchema = SchemaFactory.createForClass(Marketplace);
