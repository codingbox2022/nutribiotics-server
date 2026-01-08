import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { generateText } from 'ai';
import { Marketplace, MarketplaceDocument } from '../marketplaces/schemas/marketplace.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { MarketplacesService } from '../marketplaces/marketplaces.service';
import { google } from 'src/providers/googleAiProvider';

export interface MarketplaceDiscoveryJobData {
  triggeredBy?: string;
  timestamp: Date;
}

export interface MarketplaceDiscoveryResult {
  discovered: number;
  marketplaces: MarketplaceDocument[];
}

@Processor('marketplace-discovery')
export class MarketplaceDiscoveryProcessor extends WorkerHost {
  private readonly logger = new Logger(MarketplaceDiscoveryProcessor.name);

  constructor(
    private readonly marketplacesService: MarketplacesService,
    @InjectModel(Marketplace.name)
    private marketplaceModel: Model<MarketplaceDocument>,
    @InjectModel(Product.name)
    private productModel: Model<ProductDocument>,
  ) {
    super();
  }

  async process(job: Job<MarketplaceDiscoveryJobData>): Promise<MarketplaceDiscoveryResult> {
    this.logger.log(`Starting marketplace discovery job ${job.id}`);
    const { triggeredBy, timestamp } = job.data;

    const COUNTRY = 'Colombia';
    const IVA_RATE = 0.19;

    try {
      await job.updateProgress(10);
      this.logger.log('Starting marketplace discovery from products...');

      // Get all active products with brand information
      const products = await this.productModel
        .find({ status: 'active', comparedTo: null })
        .populate({ path: 'brand', select: 'name' })
        .exec();

      this.logger.log(`Found ${products.length} active products`);

      if (products.length === 0) {
        this.logger.warn('No active products found. Skipping marketplace discovery.');
        await job.updateProgress(100);
        return { discovered: 0, marketplaces: [] };
      }

      await job.updateProgress(25);

      // Build product list in "Brand → Name" format
      const productList = products
        .map((product) => {
          const brandName = (product.brand as any)?.name || 'Unknown';
          return `${brandName} → ${product.name}`;
        })
        .join('\n');

      await job.updateProgress(35);

      // Get existing marketplace names to exclude
      const existingMarketplaces = await this.marketplaceModel
        .find({ country: COUNTRY })
        .select('name')
        .exec();

      const existingMarketplaceNames = existingMarketplaces
        .map((m) => m.name)
        .join(', ');

      await job.updateProgress(45);

      // Build prompt for LLM
      const prompt = `<instructions>
Given this list of products (in format "Brand → Product Name"), find online stores/marketplaces in ${COUNTRY} where these products are sold.

Return each marketplace in the following format, one per line:
MarketplaceName | BaseURL

CRITICAL formatting requirements:
- BaseURL must be ONLY the clean homepage URL (e.g., https://example.com)
- DO NOT include any markdown formatting, links, or parentheses in the URL
- DO NOT include query parameters like ?utm_source=openai
- DO NOT wrap URLs in [text](url) format
- Each line must follow EXACTLY this format: Name | https://example.com
- Example of CORRECT format: "Amazon Colombia | https://www.amazon.com.co"
- Example of WRONG format: "Amazon Colombia | https://www.amazon.com.co ([amazon.com.co](https://www.amazon.com.co))"

Additional requirements:
- BaseURL must be the store's homepage, NOT product pages
- Only include marketplaces that are NOT already in the existing list
- Focus on legitimate online stores that sell nutritional supplements in ${COUNTRY}
</instructions>

<productList>
${productList}
</productList>

${existingMarketplaceNames ? `<excludeMarketplaces>
DO NOT include these marketplaces as they are already in the database:
${existingMarketplaceNames}
</excludeMarketplaces>` : ''}

<country>${COUNTRY}</country>`;

      // Call LLM with web search
      this.logger.log('Calling LLM to discover marketplaces...');
      await job.updateProgress(50);

      const { text } = await generateText({
        model: google('gemini-3-pro-preview'),
        prompt,
        tools: {
          google_search: google.tools.googleSearch({}),
        }
      });

      this.logger.log('LLM response received. Parsing results...');
      await job.updateProgress(70);

      // Parse response - extract lines in format "Name | URL"
      const lines = text.split('\n').filter((line) => line.trim());
      const marketplacesToCreate: Array<{
        name: string;
        baseUrl: string;
        country: string;
        ivaRate: number;
        status: 'active' | 'inactive';
      }> = [];

      for (const line of lines) {
        const trimmedLine = line.trim();
        // Look for lines with the pattern "Name | URL"
        if (trimmedLine.includes('|')) {
          const parts = trimmedLine.split('|').map((p) => p.trim());
          if (parts.length >= 2) {
            const [name, rawUrl] = parts;

            // Extract URL from various formats:
            // - Plain URL: https://example.com
            // - With parentheses: https://example.com (example.com)
            // - Markdown link: [text](https://example.com)
            // - Complex: https://example.com ([example.com](https://example.com/?utm_source=openai))
            let extractedUrl = rawUrl;

            // First, try to extract from markdown link format [text](url)
            const markdownMatch = rawUrl.match(/\[.*?\]\((https?:\/\/[^\)]+)\)/);
            if (markdownMatch) {
              extractedUrl = markdownMatch[1];
            } else {
              // Extract the first valid URL from the string
              const urlMatch = rawUrl.match(/(https?:\/\/[^\s\(\)]+)/);
              if (urlMatch) {
                extractedUrl = urlMatch[1];
              }
            }

            // Basic validation and URL cleanup
            if (name && extractedUrl && extractedUrl.startsWith('http')) {
              // Clean URL: remove UTM parameters and other query strings
              let cleanUrl = extractedUrl;
              try {
                const url = new URL(extractedUrl);
                // Keep only protocol, hostname, and port (if any)
                cleanUrl = `${url.protocol}//${url.host}`;
              } catch (error) {
                this.logger.warn(`Failed to parse URL: ${extractedUrl}. Using as-is.`);
              }

              marketplacesToCreate.push({
                name,
                baseUrl: cleanUrl,
                country: COUNTRY,
                ivaRate: IVA_RATE,
                status: 'inactive',
              });
            }
          }
        }
      }

      this.logger.log(`Parsed ${marketplacesToCreate.length} marketplaces from LLM response`);
      await job.updateProgress(80);

      // Create marketplaces in database
      const createdMarketplaces: MarketplaceDocument[] = [];
      for (const marketplaceDto of marketplacesToCreate) {
        try {
          // Check if marketplace already exists (by name or baseUrl)
          const existing = await this.marketplaceModel
            .findOne({
              $or: [
                { name: { $regex: `^${marketplaceDto.name}$`, $options: 'i' } },
                { baseUrl: marketplaceDto.baseUrl },
              ],
            })
            .exec();

          if (!existing) {
            const marketplace = await this.marketplacesService.create(marketplaceDto);
            createdMarketplaces.push(marketplace);
            this.logger.log(`Created marketplace: ${marketplaceDto.name}`);
          } else {
            this.logger.log(`Skipping duplicate marketplace: ${marketplaceDto.name}`);
          }
        } catch (error) {
          this.logger.error(
            `Error creating marketplace ${marketplaceDto.name}:`,
            error,
          );
        }
      }

      await job.updateProgress(100);

      this.logger.log(
        `Marketplace discovery job ${job.id} completed successfully. Created ${createdMarketplaces.length} new marketplaces. Triggered by: ${triggeredBy || 'system'}, at ${timestamp}`,
      );

      return {
        discovered: createdMarketplaces.length,
        marketplaces: createdMarketplaces,
      };
    } catch (error) {
      this.logger.error(
        `Failed to process marketplace discovery job ${job.id}: ${error.message}`,
      );
      throw error;
    }
  }
}
