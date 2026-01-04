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
import { MarketplacesService } from './marketplaces.service';
import { CreateMarketplaceDto } from './dto/create-marketplace.dto';
import { UpdateMarketplaceDto } from './dto/update-marketplace.dto';
import type { MarketplaceDiscoveryJobData } from '../queues/marketplace-discovery.processor';

@Controller('marketplaces')
export class MarketplacesController {
  constructor(
    private readonly marketplacesService: MarketplacesService,
    @InjectQueue('marketplace-discovery')
    private readonly marketplaceDiscoveryQueue: Queue<MarketplaceDiscoveryJobData>,
  ) {}

  @Post()
  create(@Body() createMarketplaceDto: CreateMarketplaceDto) {
    return this.marketplacesService.create(createMarketplaceDto);
  }

  @Get()
  findAll(
    @Query('search') search?: string,
    @Query('country') country?: string,
    @Query('status') status?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.marketplacesService.findAll({
      search,
      country,
      status,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.marketplacesService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateMarketplaceDto: UpdateMarketplaceDto,
  ) {
    return this.marketplacesService.update(id, updateMarketplaceDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.marketplacesService.remove(id);
  }

  @Post('discover')
  async discoverMarketplaces() {
    const job = await this.marketplaceDiscoveryQueue.add('discover-marketplaces', {
      timestamp: new Date(),
      triggeredBy: 'user',
    });

    return {
      jobId: job.id,
      message: 'Marketplace discovery job started',
      timestamp: new Date(),
    };
  }

  @Get('discover/:jobId')
  async getDiscoveryStatus(@Param('jobId') jobId: string) {
    const job = await this.marketplaceDiscoveryQueue.getJob(jobId);

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
