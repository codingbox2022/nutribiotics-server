import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateProductsBulkDto } from './dto/create-products-bulk.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { AddComparablesDto } from './dto/add-comparables.dto';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  create(@Body() createProductDto: CreateProductDto) {
    return this.productsService.create(createProductDto);
  }

  @Post('bulk')
  createBulk(@Body() createProductsBulkDto: CreateProductsBulkDto) {
    return this.productsService.createBulk(createProductsBulkDto.products);
  }

  @Get('pending')
  findPending() {
    return this.productsService.findPending();
  }

  @Get()
  findAll(
    @Query('search') search?: string,
    @Query('line') line?: string,
    @Query('segment') segment?: string,
    @Query('form') form?: string,
    @Query('alertLevel') alertLevel?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.productsService.findAll({
      search,
      line,
      segment,
      form,
      alertLevel,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateProductDto: UpdateProductDto) {
    return this.productsService.update(id, updateProductDto);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body('status') status: 'active' | 'suspended' | 'rejected' | 'pending',
  ) {
    return this.productsService.update(id, { status });
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.productsService.remove(id);
  }

  @Post(':id/comparables')
  addComparables(
    @Param('id') id: string,
    @Body() addComparablesDto: AddComparablesDto,
  ) {
    return this.productsService.addComparables(id, addComparablesDto.comparables);
  }

  @Post('process-nutribiotics')
  processNutribioticsProducts() {
    return this.productsService.processNutribioticsProducts();
  }
}
