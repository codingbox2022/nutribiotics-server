import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ApprovalStatus } from '../../common/enums/approval-status.enum';

export type RecommendationDocument = HydratedDocument<Recommendation>;

@Schema({ timestamps: true })
export class Recommendation {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'IngestionRun', required: true })
  ingestionRunId: Types.ObjectId;

  @Prop({ type: Number, required: false })
  currentPrice?: number;

  @Prop({ enum: ['raise', 'lower', 'keep'], required: true })
  recommendation: string;

  @Prop({ required: false })
  recommendationReasoning?: string;

  @Prop({ required: false })
  recommendedPrice?: number;

  @Prop({
    type: String,
    enum: Object.values(ApprovalStatus),
    default: ApprovalStatus.NOT_APPROVED,
  })
  recommendationStatus?: ApprovalStatus;

  @Prop({ required: false })
  recommendationApprovedAt?: Date;

  @Prop({ required: false })
  recommendationApprovedBy?: string;
}

export const RecommendationSchema = SchemaFactory.createForClass(Recommendation);

RecommendationSchema.index({ productId: 1, ingestionRunId: 1 }, { unique: true });
RecommendationSchema.index({ productId: 1, createdAt: -1 });
RecommendationSchema.index({ ingestionRunId: 1, createdAt: -1 });
