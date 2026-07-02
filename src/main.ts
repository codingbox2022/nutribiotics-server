import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { UsersService } from './users/users.service';
import { IngredientsService } from './ingredients/ingredients.service';
import { BrandsService } from './brands/brands.service';
import { ProductsService } from './products/products.service';
import { MarketplacesService } from './marketplaces/marketplaces.service';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { StagehandPriceFetcher } from './queues/price-fetchers/stagehand-price.fetcher';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'error', 'warn', 'debug', 'verbose'] });
  const logger = new Logger('Bootstrap');

  // Let Nest run onApplicationShutdown hooks on SIGTERM/SIGINT so the persistent
  // Chromium is closed cleanly when Dokploy stops the container.
  app.enableShutdownHooks();

  app.enableCors();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalInterceptors(new TransformInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());

  const usersService = app.get(UsersService);
  await usersService.seedDefaultUser();

  // Retire the legacy "rejected" marketplace concept (idempotent, safe per boot).
  const marketplacesService = app.get(MarketplacesService);
  await marketplacesService.migrateRetireRejected();
  // Ensure the known seed marketplaces exist (idempotent, safe per boot).
  await marketplacesService.seedMarketplaces();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  logger.log(`🚀 Server running on: http://localhost:${port}`);
  logger.log(`📊 Queue Dashboard: http://localhost:${port}/queues`);

  // Boot-time browser warm-up: launch the PERSISTENT Chromium now and KEEP it, so
  // (a) a launch failure is loud at startup with the real stack, and (b) every
  // scan reuses this one instance instead of relaunching per run (relaunching is
  // what dies in the container). On by default; set BROWSER_SELFCHECK=false to
  // skip, or BROWSER_SELFCHECK_FATAL=true to hard-fail the container (Dokploy
  // marks the deploy unhealthy) once the browser path is proven stable in prod.
  if (process.env.BROWSER_SELFCHECK !== 'false') {
    const browserFetcher = app.get(StagehandPriceFetcher, { strict: false });
    try {
      await browserFetcher.warmUp();
      logger.log('✅ Browser warm-up OK (persistent Chromium ready)');
    } catch (err) {
      logger.error(
        `❌ Browser warm-up FAILED — Chromium cannot launch; browser price lookups will be skipped: ${
          (err as Error)?.stack ?? String(err)
        }`,
      );
      // Spawn Chromium directly to surface its REAL stderr (missing lib / sandbox
      // / seccomp) instead of the opaque CDP ECONNREFUSED above.
      try {
        logger.error(
          `🔎 Chromium launch diagnostic:\n${browserFetcher.diagnoseBrowserLaunch()}`,
        );
      } catch (diagErr) {
        logger.error(`Chromium diagnostic itself failed: ${String(diagErr)}`);
      }
      if (process.env.BROWSER_SELFCHECK_FATAL === 'true') {
        process.exit(1);
      }
    }
  }
}

bootstrap().catch((err) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});
