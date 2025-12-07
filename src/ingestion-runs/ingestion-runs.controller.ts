import {
  Controller,
  Get,
  Param,
  Query,
  Post,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { IngestionRunsService } from './ingestion-runs.service';

@Controller('ingestion-runs')
export class IngestionRunsController {
  constructor(private readonly ingestionRunsService: IngestionRunsService) {}

  @Get()
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    const { runs, total } = await this.ingestionRunsService.findAll(
      pageNum,
      limitNum,
    );

    return {
      data: runs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  }

  @Get('recent')
  async findRecent(@Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const runs = await this.ingestionRunsService.findRecent(limitNum);
    return { data: runs };
  }

  @Get('status/:status')
  async findByStatus(@Param('status') status: string) {
    const validStatuses = [
      'pending',
      'running',
      'completed',
      'failed',
      'cancelled',
    ];
    if (!validStatuses.includes(status)) {
      throw new HttpException('Invalid status', HttpStatus.BAD_REQUEST);
    }

    const runs = await this.ingestionRunsService.findByStatus(status);
    return { data: runs };
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    const run = await this.ingestionRunsService.findById(id);
    if (!run) {
      throw new HttpException('Run not found', HttpStatus.NOT_FOUND);
    }
    return { data: run };
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string) {
    const run = await this.ingestionRunsService.findById(id);
    if (!run) {
      throw new HttpException('Run not found', HttpStatus.NOT_FOUND);
    }

    if (!['pending', 'running'].includes(run.status)) {
      throw new HttpException(
        'Can only cancel pending or running jobs',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.ingestionRunsService.cancel(id);
    return { message: 'Ingestion run cancelled successfully' };
  }
}
