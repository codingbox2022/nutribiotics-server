import { Injectable, Logger } from '@nestjs/common';
import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';

const ProductPriceSchema = z.object({
  price: z
    .number()
    .nullable()
    .optional()
    .describe('The product price as a number, without currency symbols'),
  currency: z
    .string()
    .nullable()
    .optional()
    .describe('Currency code like COP, USD, EUR'),
  inStock: z
    .boolean()
    .nullable()
    .default(false)
    .describe('Whether the product is currently available for purchase'),
  productName: z
    .string()
    .nullable()
    .optional()
    .describe('The exact product name shown on the page'),
});

type ProductPriceData = z.infer<typeof ProductPriceSchema>;

export interface ScrapeResult {
  price?: number;
  currency?: string;
  inStock: boolean;
  productName?: string;
  success: boolean;
  error?: string;
}

@Injectable()
export class ScrapingService {
  private readonly logger = new Logger(ScrapingService.name);

  /**
   * Scrape product price from a given URL using Stagehand
   */
  async scrapeProductPrice(
    url: string,
    marketplaceName?: string,
  ): Promise<ScrapeResult> {
    let stagehand: Stagehand | null = null;

    try {
      this.logger.log(
        `Starting scrape for ${marketplaceName || 'unknown marketplace'}: ${url}`,
      );

      // Initialize Stagehand
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error(
          'OPENAI_API_KEY is required for Stagehand scraping. Please set it in your environment variables.',
        );
      }

      // Determine environment (LOCAL vs BROWSERBASE)
      const useBrowserbase =
        process.env.BROWSERBASE_API_KEY &&
        process.env.BROWSERBASE_PROJECT_ID;

      stagehand = new Stagehand({
        env: useBrowserbase ? 'BROWSERBASE' : 'LOCAL',
        ...(useBrowserbase
          ? {
              apiKey: process.env.BROWSERBASE_API_KEY,
              projectId: process.env.BROWSERBASE_PROJECT_ID,
            }
          : {
              localBrowserLaunchOptions: {
                headless: true,
              },
            }),
        model: {
          modelName: 'gpt-4o',
          apiKey,
        },
      });

      await stagehand.init();

      const page = stagehand.context.pages()[0];
      if (!page) {
        throw new Error('Failed to create browser page');
      }

      // Navigate to the URL with timeout
      await page.goto(url, { waitUntil: 'domcontentloaded', timeoutMs: 30000 });

      // Build extraction instruction based on marketplace
      const extractionInstruction = this.buildExtractionInstruction(
        marketplaceName,
      );

      // Extract product data using Stagehand's LLM-powered extraction
      const result = await stagehand.extract(
        extractionInstruction,
        ProductPriceSchema,
      );

      // Convert null values to undefined for consistency
      const price = result.price ?? undefined;
      const currency = result.currency ?? undefined;
      const inStock = result.inStock ?? false;
      const productName = result.productName ?? undefined;

      // Warn if all fields are null/undefined (likely invalid URL or 404 page)
      if (!price && !currency && !productName) {
        this.logger.warn(
          `No product data found at ${url} - this may be an invalid URL or the product doesn't exist`,
        );
      }

      this.logger.log(
        `Successfully scraped ${url}: price=${price}, currency=${currency}, inStock=${inStock}, productName=${productName}`,
      );

      return {
        price,
        currency,
        inStock,
        productName,
        success: true,
      };
    } catch (error) {
      this.logger.error(
        `Failed to scrape ${url}: ${error.message}`,
        error.stack,
      );

      return {
        inStock: false,
        success: false,
        error: error.message,
      };
    } finally {
      // Always close the Stagehand instance
      if (stagehand) {
        try {
          await stagehand.close();
        } catch (closeError) {
          this.logger.warn(
            `Error closing Stagehand instance: ${closeError.message}`,
          );
        }
      }
    }
  }

  /**
   * Build marketplace-specific extraction instructions for better accuracy
   */
  private buildExtractionInstruction(marketplaceName?: string): string {
    const baseInstruction =
      'Extract the product price, currency code, stock availability, and product name from this page.';

    if (!marketplaceName) {
      return baseInstruction;
    }

    // Add marketplace-specific guidance
    const marketplaceInstructions: Record<string, string> = {
      Amazon: `${baseInstruction} Look for the main price near "Add to Cart" button. Stock status may be indicated by "In Stock" or "Currently unavailable" text.`,
      'Mercado Libre': `${baseInstruction} The price is usually shown prominently with "COP" or "$" symbol. Check for "Disponible" or "Agotado" for stock status.`,
      Exito: `${baseInstruction} Look for the main product price, typically in Colombian Pesos (COP). Stock availability may show as "Disponible" or similar text.`,
      Jumbo: `${baseInstruction} The price should be in COP. Stock status might be indicated by add-to-cart button availability.`,
      default: baseInstruction,
    };

    return (
      marketplaceInstructions[marketplaceName] ||
      marketplaceInstructions.default
    );
  }
}
