import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { MarketplacesService } from '../marketplaces/marketplaces.service';

async function cleanUrl(rawUrl: string): Promise<string> {
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

  // Clean URL: remove UTM parameters and other query strings
  try {
    const url = new URL(extractedUrl);
    // Keep only protocol, hostname, and port (if any)
    return `${url.protocol}//${url.host}`;
  } catch (error) {
    console.warn(`Failed to parse URL: ${extractedUrl}. Returning as-is.`);
    return extractedUrl;
  }
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const marketplacesService = app.get(MarketplacesService);

  console.log('Fetching all marketplaces...');
  const result = await marketplacesService.findAll({});
  const marketplaces = result.data;

  console.log(`Found ${marketplaces.length} marketplaces`);

  let fixedCount = 0;

  for (const marketplace of marketplaces) {
    // Check if URL contains malformed patterns
    if (
      marketplace.baseUrl.includes('(') ||
      marketplace.baseUrl.includes('[') ||
      marketplace.baseUrl.includes('utm_source')
    ) {
      const cleanedUrl = await cleanUrl(marketplace.baseUrl);

      if (cleanedUrl !== marketplace.baseUrl) {
        console.log(`Fixing: ${marketplace.name}`);
        console.log(`  Old URL: ${marketplace.baseUrl}`);
        console.log(`  New URL: ${cleanedUrl}`);

        await marketplacesService.update(marketplace._id.toString(), {
          baseUrl: cleanedUrl,
        });

        fixedCount++;
      }
    }
  }

  console.log(`\nFixed ${fixedCount} marketplace URLs`);

  await app.close();
}

bootstrap();
