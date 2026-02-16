import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  IngestionRun,
  IngestionRunDocument,
  LookupResult,
} from './schemas/ingestion-run.schema';
import { Recommendation, RecommendationDocument } from '../recommendations/schemas/recommendation.schema';

@Injectable()
export class IngestionRunsService {
  private readonly logger = new Logger(IngestionRunsService.name);

  constructor(
    @InjectModel(IngestionRun.name)
    private ingestionRunModel: Model<IngestionRunDocument>,
    @InjectModel(Recommendation.name)
    private recommendationModel: Model<RecommendationDocument>,
  ) {}

  /**
   * Create a new ingestion run
   */
  async create(
    triggeredBy: string,
    totalProducts: number,
    totalLookups: number,
    productId?: string,
  ): Promise<IngestionRunDocument> {
    const ingestionRun = new this.ingestionRunModel({
      status: 'pending',
      triggeredBy,
      triggeredAt: new Date(),
      totalProducts,
      totalLookups,
      processedProducts: 0,
      completedLookups: 0,
      failedLookups: 0,
      results: [],
      ...(productId && { productId: new Types.ObjectId(productId) }),
    });

    const saved = await ingestionRun.save();
    this.logger.log(`Created ingestion run ${saved._id}`);
    return saved;
  }

  /**
   * Mark a run as started
   */
  async markAsRunning(id: string | Types.ObjectId): Promise<void> {
    await this.ingestionRunModel.findByIdAndUpdate(id, {
      status: 'running',
      startedAt: new Date(),
    });
    this.logger.log(`Ingestion run ${id} started`);
  }

  /**
   * Mark a run as completed
   */
  async markAsCompleted(id: string | Types.ObjectId): Promise<void> {
    const run = await this.ingestionRunModel.findById(id);
    if (!run) return;

    // Calculate final stats
    const allProductIds = new Set(
      run.results.map((r) => r.productId.toString()),
    );

    const productsWithPricesSet = new Set(
      run.results
        .filter((r) => r.lookupStatus === 'success' && r.price !== undefined)
        .map((r) => r.productId.toString()),
    );

    const productsWithPrices = productsWithPricesSet.size;

    // Count products that have NO successful lookups at all
    const productsNotFound = [...allProductIds].filter(
      (id) => !productsWithPricesSet.has(id),
    ).length;

    // Count unique products with recommendations for this run
    const recommendationResults = await this.recommendationModel.aggregate([
      {
        $match: {
          ingestionRunId: new Types.ObjectId(id),
          recommendation: { $in: ['raise', 'lower'] },
        },
      },
      { $group: { _id: '$productId' } },
      { $count: 'total' },
    ]);
    const productsWithRecommendations = recommendationResults[0]?.total || 0;

    await this.ingestionRunModel.findByIdAndUpdate(id, {
      status: 'completed',
      completedAt: new Date(),
      productsWithPrices,
      productsNotFound,
      productsWithRecommendations,
    });

    this.logger.log(`Ingestion run ${id} completed`);
  }

  /**
   * Mark a run as failed
   */
  async markAsFailed(
    id: string | Types.ObjectId,
    errorMessage: string,
    errorStack?: string,
  ): Promise<void> {
    await this.ingestionRunModel.findByIdAndUpdate(id, {
      status: 'failed',
      failedAt: new Date(),
      errorMessage,
      errorStack,
    });
    this.logger.error(`Ingestion run ${id} failed: ${errorMessage}`);
  }

  /**
   * Add a lookup result to the run
   */
  async addLookupResult(
    id: string | Types.ObjectId,
    result: LookupResult,
  ): Promise<void> {
    const update: any = {
      $push: { results: result },
    };

    if (result.lookupStatus === 'success') {
      update.$inc = { completedLookups: 1 };
    } else if (result.lookupStatus === 'error') {
      update.$inc = { failedLookups: 1 };
    } else {
      // not_found
      update.$inc = { completedLookups: 1 };
    }

    await this.ingestionRunModel.findByIdAndUpdate(id, update);
  }

  /**
   * Update progress counters
   */
  async updateProgress(
    id: string | Types.ObjectId,
    processedProducts: number,
  ): Promise<void> {
    await this.ingestionRunModel.findByIdAndUpdate(id, {
      processedProducts,
    });
  }

  /**
   * Get a run by ID
   */
  async findById(id: string | Types.ObjectId): Promise<IngestionRunDocument | null> {
    return this.ingestionRunModel.findById(id);
  }

  /**
   * Get all runs with pagination
   */
  async findAll(
    page = 1,
    limit = 10,
  ): Promise<{ runs: IngestionRunDocument[]; total: number }> {
    const skip = (page - 1) * limit;

    const [runs, total] = await Promise.all([
      this.ingestionRunModel
        .find()
        .select('-results')
        .sort({ triggeredAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.ingestionRunModel.countDocuments(),
    ]);

    return { runs, total };
  }

  /**
   * Get recent runs
   */
  async findRecent(limit = 10): Promise<IngestionRunDocument[]> {
    return this.ingestionRunModel
      .find()
      .sort({ triggeredAt: -1 })
      .limit(limit)
      .exec();
  }

  /**
   * Get runs by status
   */
  async findByStatus(status: string): Promise<IngestionRunDocument[]> {
    return this.ingestionRunModel.find({ status }).sort({ triggeredAt: -1 });
  }

  /**
   * Cancel a pending or running job
   */
  async cancel(id: string | Types.ObjectId): Promise<void> {
    await this.ingestionRunModel.findByIdAndUpdate(id, {
      status: 'cancelled',
      completedAt: new Date(),
    });
    this.logger.log(`Ingestion run ${id} cancelled`);
  }

  /**
   * Check if a run has been cancelled
   */
  async isCancelled(id: string | Types.ObjectId): Promise<boolean> {
    const run = await this.ingestionRunModel.findById(id).select('status').lean().exec();
    return run?.status === 'cancelled';
  }
}
