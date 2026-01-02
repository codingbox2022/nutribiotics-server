import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BrandDocument = HydratedDocument<Brand>;

export enum ApprovalStatus {
  NOT_APPROVED = 'not_approved',
  REJECTED = 'rejected',
  APPROVED = 'approved',
}

@Schema({ timestamps: true })
export class Brand {
  @Prop({ required: true, unique: true })
  name: string;

  @Prop({
    type: String,
    enum: Object.values(ApprovalStatus),
    default: ApprovalStatus.NOT_APPROVED
  })
  status: ApprovalStatus;
}

export const BrandSchema = SchemaFactory.createForClass(Brand);
