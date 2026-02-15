import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ProductsService } from '../products/products.service';

export interface ProductDiscoveryJobData {
  triggeredBy?: string;
  timestamp: Date;
  productId?: string;
}

export interface ProductDiscoveryResult {
  processed: number;
  newProducts: number;
  newIngredients: number;
  newBrands: number;
}

@Processor('product-discovery')
export class ProductDiscoveryProcessor extends WorkerHost {
  private readonly logger = new Logger(ProductDiscoveryProcessor.name);

  constructor(private readonly productsService: ProductsService) {
    super();
  }

  async process(job: Job<ProductDiscoveryJobData>): Promise<ProductDiscoveryResult> {
    this.logger.log(`Starting product discovery job ${job.id}`);
    const { triggeredBy, timestamp, productId } = job.data;

    try {
      await job.updateProgress(5);
      this.logger.log('Starting Nutribiotics product processing...');

      // Track metrics
      let processedCount = 0;
      let newProductsCount = 0;
      let newIngredientsCount = 0;
      let newBrandsCount = 0;

      // Progress callback to update job progress
      const progressCallback = async (progress: number) => {
        await job.updateProgress(progress);
      };

      // Call the product processing service with progress callback
      const result = await this.productsService.processNutribioticsProducts(
        progressCallback,
        productId,
      );

      // Update counts from result
      processedCount = result.processed || 0;
      newProductsCount = result.newProducts || 0;
      newIngredientsCount = result.newIngredients || 0;
      newBrandsCount = result.newBrands || 0;

      await job.updateProgress(100);

      this.logger.log(
        `Product discovery job ${job.id} completed successfully. ` +
        `Processed: ${processedCount}, New Products: ${newProductsCount}, ` +
        `New Ingredients: ${newIngredientsCount}, New Brands: ${newBrandsCount}. ` +
        `Triggered by: ${triggeredBy || 'system'}, at ${timestamp}`,
      );

      return {
        processed: processedCount,
        newProducts: newProductsCount,
        newIngredients: newIngredientsCount,
        newBrands: newBrandsCount,
      };
    } catch (error) {
      this.logger.error(
        `Failed to process product discovery job ${job.id}: ${error.message}`,
      );
      throw error;
    }
  }
}
