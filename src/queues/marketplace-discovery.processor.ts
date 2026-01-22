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

      // ---------------------------------------------------------------------
      // Load products (used only as context for discovery)
      // ---------------------------------------------------------------------
      const products = await this.productModel
        .find({ status: 'active', comparedTo: null })
        .populate({ path: 'brand', select: 'name' })
        .exec();

      if (!products.length) {
        this.logger.warn('No active products found. Skipping marketplace discovery.');
        await job.updateProgress(100);
        return { discovered: 0, marketplaces: [] };
      }

      const productList = products
        .map((p) => `${(p.brand as any)?.name || 'Unknown'} → ${p.name}`)
        .join('\n');

      await job.updateProgress(30);

      // ---------------------------------------------------------------------
      // Exclude ALL known marketplaces (active or rejected)
      // ---------------------------------------------------------------------
      const existingMarketplaces = await this.marketplaceModel
        .find({ country: COUNTRY })
        .select('name')
        .exec();

      const existingMarketplaceNames = existingMarketplaces
        .map((m) => m.name)
        .join(', ');

      await job.updateProgress(45);

      // ---------------------------------------------------------------------
      // DISCOVERY PROMPT (CLASSIFICATION-BASED)
      // ---------------------------------------------------------------------
      const prompt = `
You are discovering online marketplaces in Colombia that sell nutritional supplements.

Your task has TWO goals:
1) Discover legitimate online marketplaces
2) Classify whether each marketplace is suitable for AUTOMATED PRODUCT SEARCH using Google-indexed product pages

IMPORTANT:
Some marketplaces are real and legitimate but are NOT suitable for automated search.
These MUST be included and marked as REJECTED, not ignored.

--------------------------------
DEFINITIONS
--------------------------------

ACCEPTED marketplace:
- Has individual product pages
- Product pages are publicly accessible and indexed by Google
- Products can be found using queries like:
  "Product Name" site:example.com
- Does NOT require internal JS-only search to see products

REJECTED marketplace:
- Products are only accessible via internal search
- Product pages are not Google-indexed
- Site is JS-heavy, app-only, or hides inventory
- Or primarily sells products offline
- Or does not reliably list nutritional supplements online

--------------------------------
OUTPUT FORMAT (STRICT)
--------------------------------

Return ONE marketplace per line using EXACTLY this format:

MarketplaceName | BaseURL | STATUS | REASON

Where:
- BaseURL is the clean homepage URL (e.g. https://example.com)
- STATUS is either ACCEPTED or REJECTED
- REASON is a short explanation (max 12 words)

Examples:
Farmatodo Colombia | https://www.farmatodo.com.co | REJECTED | Products not indexed, internal search only
Mercado Libre Colombia | https://www.mercadolibre.com.co | ACCEPTED | Public product pages indexed by Google

--------------------------------
RULES
--------------------------------
- Include BOTH ACCEPTED and REJECTED marketplaces
- DO NOT omit marketplaces just because they are rejected
- DO NOT include marketplaces already in the exclude list
- DO NOT include product page URLs
- DO NOT include markdown or numbering
- One marketplace per line only

--------------------------------
SCOPE
--------------------------------
Country: ${COUNTRY}
Focus: nutritional supplements and vitamins

<ProductList>
${productList}
</ProductList>

<ExcludeMarketplaces>
${existingMarketplaceNames}
</ExcludeMarketplaces>
      `.trim();

      this.logger.log('Calling LLM for classified marketplace discovery...');
      await job.updateProgress(55);

      const { text } = await generateText({
        model: google('gemini-3-pro-preview'),
        prompt,
        tools: {
          google_search: google.tools.googleSearch({}),
        },
      });

      await job.updateProgress(70);

      // ---------------------------------------------------------------------
      // PARSE RESPONSE
      // ---------------------------------------------------------------------
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

      const marketplacesToCreate: Array<{
        name: string;
        baseUrl: string;
        status: 'active' | 'rejected';
        rejectionReason?: string;
      }> = [];

      for (const line of lines) {
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length !== 4) continue;

        const [name, rawUrl, statusRaw, reason] = parts;
        if (!name || !rawUrl || !statusRaw) continue;

        let cleanUrl = rawUrl;
        try {
          const u = new URL(rawUrl);
          cleanUrl = `${u.protocol}//${u.host}`;
        } catch {
          continue;
        }

        const status =
          statusRaw.toUpperCase() === 'ACCEPTED' ? 'active' : 'rejected';

        marketplacesToCreate.push({
          name,
          baseUrl: cleanUrl,
          status,
          rejectionReason: status === 'rejected' ? reason : undefined,
        });
      }

      await job.updateProgress(85);

      // ---------------------------------------------------------------------
      // CREATE MARKETPLACES (INCLUDING REJECTED)
      // ---------------------------------------------------------------------
      const createdMarketplaces: MarketplaceDocument[] = [];

      for (const dto of marketplacesToCreate) {
        const exists = await this.marketplaceModel.findOne({
          $or: [
            { name: { $regex: `^${dto.name}$`, $options: 'i' } },
            { baseUrl: dto.baseUrl },
          ],
        });

        if (exists) continue;

        const marketplace = await this.marketplacesService.create({
          name: dto.name,
          baseUrl: dto.baseUrl,
          country: COUNTRY,
          ivaRate: IVA_RATE,
          status: dto.status,
          rejectionReason: dto.rejectionReason,
          seenByUser: false,
          searchCapabilities: {
            googleIndexedProducts: dto.status === 'active',
          },
        } as any);

        createdMarketplaces.push(marketplace);
        this.logger.log(
          `Created marketplace: ${dto.name} (${dto.status})`,
        );
      }

      await job.updateProgress(100);

      this.logger.log(
        `Marketplace discovery completed. Created ${createdMarketplaces.length} marketplaces.`,
      );

      return {
        discovered: createdMarketplaces.length,
        marketplaces: createdMarketplaces,
      };
    } catch (error) {
      this.logger.error(
        `Marketplace discovery job failed: ${error.message}`,
      );
      throw error;
    }
  }
}
