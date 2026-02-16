import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Recommendation, RecommendationDocument } from './schemas/recommendation.schema';
import { Price, PriceDocument } from '../prices/schemas/price.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { PriceHistory, PriceHistoryDocument } from '../prices/schemas/price-history.schema';
import { ApprovalStatus } from '../common/enums/approval-status.enum';

interface CreateRecommendationInput {
  productId: string | Types.ObjectId;
  ingestionRunId: string | Types.ObjectId;
  currentPrice?: number | null;
  recommendation: 'raise' | 'lower' | 'keep';
  recommendationReasoning?: string;
  recommendedPrice?: number;
}

@Injectable()
export class RecommendationsService {
  constructor(
    @InjectModel(Recommendation.name) private recommendationModel: Model<RecommendationDocument>,
    @InjectModel(Price.name) private priceModel: Model<PriceDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(PriceHistory.name) private priceHistoryModel: Model<PriceHistoryDocument>,
  ) {}

  async upsertRecommendation(input: CreateRecommendationInput): Promise<RecommendationDocument> {
    const productId = typeof input.productId === 'string'
      ? new Types.ObjectId(input.productId)
      : input.productId;
    const ingestionRunId = typeof input.ingestionRunId === 'string'
      ? new Types.ObjectId(input.ingestionRunId)
      : input.ingestionRunId;

    return this.recommendationModel.findOneAndUpdate(
      { productId, ingestionRunId },
      {
        productId,
        ingestionRunId,
        currentPrice: input.currentPrice ?? null,
        recommendation: input.recommendation,
        recommendationReasoning: input.recommendationReasoning,
        recommendedPrice: input.recommendedPrice,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).exec();
  }

  async getLatestRecommendationForProduct(
    productId: string,
    ingestionRunId?: string,
  ): Promise<RecommendationDocument | null> {
    const filter: any = { productId: new Types.ObjectId(productId) };
    if (ingestionRunId) {
      filter.ingestionRunId = new Types.ObjectId(ingestionRunId);
    }

    return this.recommendationModel
      .findOne(filter)
      .sort({ createdAt: -1 })
      .exec();
  }

  async findByRunIdAndProductIds(
    ingestionRunId: string,
    productIds: string[],
  ): Promise<RecommendationDocument[]> {
    return this.recommendationModel
      .find({
        ingestionRunId: new Types.ObjectId(ingestionRunId),
        productId: { $in: productIds.map((id) => new Types.ObjectId(id)) },
      })
      .exec();
  }

  async acceptRecommendation(recommendationId: string, user: any): Promise<any> {
    const recommendation = await this.recommendationModel.findById(recommendationId).exec();
    if (!recommendation) {
      throw new NotFoundException(`Recommendation with ID ${recommendationId} not found`);
    }

    if (!recommendation.recommendedPrice) {
      throw new BadRequestException('No recommended price available');
    }

    const product = await this.productModel.findById(recommendation.productId).exec();
    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const IVA_RATE = 0.19;
    const precioConIva = recommendation.recommendedPrice;
    const precioSinIva = precioConIva / (1 + IVA_RATE);

    const ingredientContent = product.ingredientContent instanceof Map
      ? Object.fromEntries(product.ingredientContent)
      : (product.ingredientContent || {});

    const pricePerIngredientContent: Record<string, number> = {};
    for (const [ingredientId, content] of Object.entries(ingredientContent)) {
      const numContent = Number(content);
      pricePerIngredientContent[ingredientId] = numContent > 0 ? precioSinIva / numContent : 0;
    }

    const existingPrice = await this.priceModel
      .findOne({ productId: product._id, marketplaceId: null })
      .sort({ createdAt: -1 })
      .exec();

    const oldPrecioConIva = existingPrice?.precioConIva ?? recommendation.currentPrice ?? 0;
    const oldPrecioSinIva = existingPrice?.precioSinIva ?? (recommendation.currentPrice ?? 0) / (1 + IVA_RATE);

    let price = existingPrice;

    if (!price) {
      price = new this.priceModel({
        productId: product._id,
        marketplaceId: null,
        precioConIva,
        precioSinIva,
        ingredientContent,
        pricePerIngredientContent,
      });
      await price.save();
    }

    const priceHistory = new this.priceHistoryModel({
      priceId: price._id,
      productId: price.productId,
      oldPrecioConIva,
      newPrecioConIva: precioConIva,
      oldPrecioSinIva,
      newPrecioSinIva: precioSinIva,
      changeReason: 'recommendation_accepted',
      recommendation: recommendation.recommendation,
      recommendedPrice: recommendation.recommendedPrice,
      recommendationReasoning: recommendation.recommendationReasoning,
      changedBy: user?.email || user?.id,
    });
    await priceHistory.save();

    await this.priceModel.findByIdAndUpdate(price._id, {
      precioConIva,
      precioSinIva,
      pricePerIngredientContent,
    }).exec();

    const updatedRecommendation = await this.recommendationModel.findByIdAndUpdate(
      recommendationId,
      {
        recommendationStatus: ApprovalStatus.APPROVED,
        recommendationApprovedAt: new Date(),
        recommendationApprovedBy: user?.email || user?.id,
      },
      { new: true }
    ).exec();

    return { success: true, data: updatedRecommendation };
  }

  async rejectRecommendation(recommendationId: string, user: any): Promise<any> {
    const recommendation = await this.recommendationModel.findByIdAndUpdate(
      recommendationId,
      {
        recommendationStatus: ApprovalStatus.REJECTED,
        recommendationApprovedAt: new Date(),
        recommendationApprovedBy: user?.email || user?.id,
      },
      { new: true }
    ).exec();

    if (!recommendation) {
      throw new NotFoundException(`Recommendation with ID ${recommendationId} not found`);
    }

    return { success: true, data: recommendation };
  }

  async bulkAcceptRecommendations(recommendationIds: string[], user: any): Promise<any> {
    const results = {
      successful: 0,
      failed: 0,
      skipped: 0,
      errors: [] as { recommendationId: string; error: string }[],
    };

    for (const recommendationId of recommendationIds) {
      try {
        const recommendation = await this.recommendationModel.findById(recommendationId).exec();
        if (!recommendation) {
          results.failed++;
          results.errors.push({
            recommendationId,
            error: 'Recommendation not found',
          });
          continue;
        }

        if (recommendation.recommendation === 'keep') {
          results.skipped++;
          continue;
        }

        await this.acceptRecommendation(recommendationId, user);
        results.successful++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          recommendationId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return {
      success: results.failed === 0,
      data: results,
    };
  }
}
