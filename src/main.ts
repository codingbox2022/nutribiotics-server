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

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'error', 'warn', 'debug', 'verbose'] });
  const logger = new Logger('Bootstrap');

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
}

bootstrap().catch((err) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});
