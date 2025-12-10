import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { UsersService } from './users/users.service';
import { IngredientsService } from './ingredients/ingredients.service';
import { BrandsService } from './brands/brands.service';
import { ProductsService } from './products/products.service';
import { MarketplacesService } from './marketplaces/marketplaces.service';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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

  const ingredientsService = app.get(IngredientsService);
  await ingredientsService.seedIngredients();

  const brandsService = app.get(BrandsService);
  await brandsService.seedBrands();

  const marketplacesService = app.get(MarketplacesService);
  await marketplacesService.seedMarketplaces();

  const productsService = app.get(ProductsService);
  await productsService.seedProducts();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  console.log(`\n🚀 Server running on: http://localhost:${port}`);
  console.log(`📊 Queue Dashboard: http://localhost:${port}/queues\n`);
}
void bootstrap();
