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
1) Discover legitimate online marketplaces that sell nutritional supplements
2) Classify HOW each marketplace's product prices can be read automatically

Every legitimate supplement marketplace must be INCLUDED. There is no "rejected"
category — sites that are hard to read automatically are simply marked BROWSER.

--------------------------------
SCAN STRATEGY
--------------------------------

SEARCH (prefer when confident):
- Has individual product pages publicly accessible and indexed by Google
- Products can be found using queries like:
  "Product Name" site:example.com

BROWSER (use when NOT confident about the above):
- Products are only accessible via the site's internal search
- Product pages are not reliably indexed by Google
- Site is JS-heavy, single-page-app, or hides inventory behind search

--------------------------------
OUTPUT FORMAT (STRICT)
--------------------------------

Return ONE marketplace per line using EXACTLY this format:

MarketplaceName | BaseURL | STRATEGY

Where:
- BaseURL is the clean homepage URL (e.g. https://example.com)
- STRATEGY is either SEARCH or BROWSER

Examples:
Farmatodo Colombia | https://www.farmatodo.com.co | BROWSER
Mercado Libre Colombia | https://www.mercadolibre.com.co | SEARCH

--------------------------------
RULES
--------------------------------
- Include every legitimate supplement marketplace you find
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
        scanStrategy: 'search' | 'browser';
      }> = [];

      for (const line of lines) {
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 3) continue;

        const [name, rawUrl, strategyRaw] = parts;
        if (!name || !rawUrl || !strategyRaw) continue;

        let cleanUrl = rawUrl;
        try {
          const u = new URL(rawUrl);
          cleanUrl = `${u.protocol}//${u.host}`;
        } catch {
          continue;
        }

        const scanStrategy =
          strategyRaw.toUpperCase() === 'BROWSER' ? 'browser' : 'search';

        marketplacesToCreate.push({
          name,
          baseUrl: cleanUrl,
          scanStrategy,
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
          status: 'active',
          seenByUser: false,
          scanStrategy: dto.scanStrategy,
        } as any);

        createdMarketplaces.push(marketplace);
        this.logger.log(
          `Created marketplace: ${dto.name} (${dto.scanStrategy})`,
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
