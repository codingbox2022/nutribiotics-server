import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { ApprovalStatus } from '../../common/enums/approval-status.enum';

export type BrandDocument = HydratedDocument<Brand>;

@Schema({ timestamps: true })
export class Brand {
  @Prop({ required: true, unique: true })
  name: string;

  @Prop({
    type: String,
    enum: Object.values(ApprovalStatus),
    default: ApprovalStatus.APPROVED
  })
  status: ApprovalStatus;
}

export const BrandSchema = SchemaFactory.createForClass(Brand);
