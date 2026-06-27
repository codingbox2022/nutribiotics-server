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

  // How this marketplace's prices are acquired during a scan:
  // 'search' = Google-indexed (cheap LLM web search), 'browser' = needs a real browser.
  @Prop({ enum: ['search', 'browser'], default: 'search' })
  scanStrategy: string;

  // Optional natural-language instruction the browser fetcher runs BEFORE searching,
  // for sites that gate prices (e.g. Farmatodo's city picker). Overrides the generic
  // cookie/location priming default. Only used when scanStrategy === 'browser'.
  @Prop({ type: String, required: false })
  browserSetup?: string;

  @Prop({ default: 0 })
  productsScanned: number;

  @Prop({ default: null })
  lastScanDate: Date;

  @Prop({ default: false })
  seenByUser: boolean;
}

export const MarketplaceSchema = SchemaFactory.createForClass(Marketplace);
