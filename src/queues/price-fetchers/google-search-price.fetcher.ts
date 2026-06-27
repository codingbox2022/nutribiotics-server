import { Injectable, Logger } from '@nestjs/common';
import { generateText } from 'ai';
import { z } from 'zod';
import { google } from '../../providers/googleAiProvider';
import {
  MarketplacePriceFetcher,
  MarketplacePriceLookup,
  PriceFetchContext,
} from './price-fetcher.interface';

// Same shape the processor used inline; the LLM is asked to return this JSON.
const searchSchema = z.object({
  precioSinIva: z.number().nullable().optional(),
  precioConIva: z.number().nullable().optional(),
  productUrl: z.string().nullable().optional(),
  productName: z.string().nullable().optional(),
  inStock: z.boolean().default(false),
  currency: z.string().nullable().optional(),
});

const EMPTY_RESULT: MarketplacePriceLookup = {
  precioSinIva: null,
  precioConIva: null,
  productUrl: null,
  productName: null,
  inStock: false,
  currency: null,
};

/**
 * Acquisition strategy for Google-indexed marketplaces: a Gemini call grounded
 * with the google_search tool. This is the original (and only) behavior, lifted
 * out of price-comparison.processor.ts verbatim and exposed behind the
 * MarketplacePriceFetcher contract.
 */
@Injectable()
export class GoogleSearchPriceFetcher implements MarketplacePriceFetcher {
  readonly strategy = 'search' as const;
  private readonly logger = new Logger(GoogleSearchPriceFetcher.name);

  async fetchPrice(ctx: PriceFetchContext): Promise<MarketplacePriceLookup> {
    const { marketplace, product, brandName, country } = ctx;
    const {
      countryName: SEARCH_COUNTRY_NAME,
      gl: SEARCH_COUNTRY_GL,
      currencyName: SEARCH_CURRENCY_NAME,
      currencyCode: SEARCH_CURRENCY_CODE,
    } = country;

    const prompt = `You can assume the marketplace "${marketplace.name}" has searchable, Google-indexed product pages. Find the closest available match (exact or equivalent) for "${product.name}" from brand "${brandName}". Accept equivalent product sizes or bundles if they clearly represent the same item.

                  IMPORTANT: Search explicitly for ${SEARCH_COUNTRY_NAME}N stores (gl=${SEARCH_COUNTRY_GL}). The price MUST be in ${SEARCH_CURRENCY_NAME} (${SEARCH_CURRENCY_CODE}).
                  - Do NOT return prices in USD, EUR, or other currencies.
                  - Do NOT return results from international stores (e.g., amazon.com, ebay.com) unless they are explicitly the ${SEARCH_COUNTRY_NAME}N version (e.g., amazon.com.${SEARCH_COUNTRY_GL} is not real, but if it ships to ${SEARCH_COUNTRY_NAME} in ${SEARCH_CURRENCY_CODE} that is okay, but prefer local stores).
                  - If the store is international and does not show price in ${SEARCH_CURRENCY_CODE}, treat it as "inStock": false.

                  Only return inStock as false when you have strong evidence that the product and its close equivalents are unavailable after searching multiple result pages. Otherwise provide the best available match.

                  Return ONLY a valid JSON object (no markdown, no extra text) with the following fields:
                  - precioSinIva (number or null): Price without tax/IVA/VAT if shown on the page
                  - precioConIva (number or null): Price with tax/IVA/VAT included (usually the main displayed price). MUST BE IN ${SEARCH_CURRENCY_CODE}.
                  - productUrl (string): URL to the product page
                  - productName (string): The exact product name found
                  - inStock (boolean): Whether the product is available
                  - currency (string): The currency of the found price (e.g., "${SEARCH_CURRENCY_CODE}", "USD").

                  If only one price is shown, put it in precioConIva and set precioSinIva to null.`;

    const result = await generateText({
      model: google('gemini-2.5-flash'),
      prompt,
      tools: {
        google_search: google.tools.googleSearch({}),
      },
    });

    return this.parseResponse(result.text, product.name, marketplace.name);
  }

  /** Tolerant JSON extraction; any failure degrades to "not found", as before. */
  private parseResponse(
    text: string | undefined,
    productName: string,
    marketplaceName: string,
  ): MarketplacePriceLookup {
    try {
      if (!text || text.trim() === '') {
        this.logger.warn(
          `Empty LLM response for ${productName} on ${marketplaceName}, treating as not found`,
        );
        return { ...EMPTY_RESULT };
      }

      let jsonText = text.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/```json?\n?/g, '').replace(/```\n?$/g, '');
      }

      const firstBrace = jsonText.indexOf('{');
      const lastBrace = jsonText.lastIndexOf('}');
      if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        this.logger.warn(
          `No valid JSON object found in LLM response for ${productName} on ${marketplaceName}, treating as not found. Raw: ${text.substring(0, 200)}`,
        );
        return { ...EMPTY_RESULT };
      }

      jsonText = jsonText.substring(firstBrace, lastBrace + 1);
      const parsed = searchSchema.parse(JSON.parse(jsonText));
      return {
        precioSinIva: parsed.precioSinIva ?? null,
        precioConIva: parsed.precioConIva ?? null,
        productUrl: parsed.productUrl ?? null,
        productName: parsed.productName ?? null,
        inStock: parsed.inStock ?? false,
        currency: parsed.currency ?? null,
      };
    } catch (parseError: any) {
      this.logger.warn(
        `Failed to parse LLM response for ${productName} on ${marketplaceName}: ${parseError.message}. Treating as not found. Raw response: ${text?.substring(0, 200) || '(empty)'}`,
      );
      return { ...EMPTY_RESULT };
    }
  }
}
