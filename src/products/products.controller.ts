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
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateProductsBulkDto } from './dto/create-products-bulk.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { AddComparablesDto } from './dto/add-comparables.dto';
import type { ProductDiscoveryJobData } from '../queues/product-discovery.processor';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    @InjectQueue('product-discovery')
    private readonly productDiscoveryQueue: Queue<ProductDiscoveryJobData>,
  ) {}

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
    @Body('status') status: 'active' | 'inactive' | 'rejected' | 'deleted',
    @Body('name') name?: string,
  ) {
    const updateData: any = { status };
    if (name) {
      updateData.name = name;
    }
    return this.productsService.update(id, updateData);
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
  async processNutribioticsProducts(@Body() body?: { productId?: string }) {
    const job = await this.productDiscoveryQueue.add('discover-products', {
      timestamp: new Date(),
      triggeredBy: 'user',
      productId: body?.productId,
    });

    return {
      jobId: job.id,
      message: 'Product discovery job started',
      timestamp: new Date(),
    };
  }

  @Get('process-nutribiotics/:jobId')
  async getProcessingStatus(@Param('jobId') jobId: string) {
    const job = await this.productDiscoveryQueue.getJob(jobId);

    if (!job) {
      return {
        status: 'not_found',
        message: 'Job not found',
      };
    }

    const state = await job.getState();
    const progress = job.progress;
    const result = job.returnvalue;
    const failedReason = job.failedReason;

    return {
      jobId: job.id,
      status: state,
      progress,
      result,
      failedReason,
    };
  }
}
