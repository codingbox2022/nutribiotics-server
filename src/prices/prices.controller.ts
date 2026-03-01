import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  Request,
  StreamableFile,
  NotFoundException,
} from '@nestjs/common';
import { PricesService } from './prices.service';
import { ExportCacheService } from './export-cache.service';
import { CreatePriceDto } from './dto/create-price.dto';
import { UpdatePriceDto } from './dto/update-price.dto';
import { FindAllPricesDto } from './dto/find-all-prices.dto';

@Controller('prices')
export class PricesController {
  constructor(
    private readonly pricesService: PricesService,
    private readonly exportCacheService: ExportCacheService,
  ) {}

  @Post()
  create(@Body() createPriceDto: CreatePriceDto) {
    return this.pricesService.create(createPriceDto);
  }

  @Get('nutribiotics-comparison')
  getNutribioticsComparison(@Query('search') search?: string) {
    return this.pricesService.getNutribioticsComparison({ search });
  }

  @Get()
  findAll(@Query() query: FindAllPricesDto) {
    return this.pricesService.findAll(query);
  }

  @Get('product-detail/:productId')
  getProductPriceDetail(
    @Param('productId') productId: string,
    @Query('ingestionRunId') ingestionRunId?: string,
  ) {
    return this.pricesService.getProductPriceDetail(productId, ingestionRunId);
  }

  @Get('comparison-results/:ingestionRunId')
  getComparisonResults(
    @Param('ingestionRunId') ingestionRunId: string,
    @Query('search') search?: string
  ) {
    return this.pricesService.getComparisonResultsByRunId(ingestionRunId, { search });
  }

  @Get('export-download/:jobId')
  async downloadExport(
    @Param('jobId') jobId: string,
    @Query('ingestionRunId') ingestionRunId: string,
  ) {
    const buffer = this.exportCacheService.get(jobId);
    if (!buffer) {
      throw new NotFoundException('Export not found or expired. Please generate the report again.');
    }
    const filename = ingestionRunId
      ? `resultados-comparacion-${ingestionRunId}.xlsx`
      : `resultados-comparacion-${jobId}.xlsx`;
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Post('recommendations/bulk-accept')
  bulkAcceptRecommendations(@Body() body: { recommendationIds: string[] }, @Request() req) {
    return this.pricesService.bulkAcceptRecommendations(body.recommendationIds, req.user);
  }

  @Post('recommendation/:id/accept')
  acceptRecommendation(@Param('id') id: string, @Request() req) {
    return this.pricesService.acceptRecommendation(id, req.user);
  }

  @Post('recommendation/:id/reject')
  rejectRecommendation(@Param('id') id: string, @Request() req) {
    return this.pricesService.rejectRecommendation(id, req.user);
  }

  @Get('product/:productId')
  findByProduct(@Param('productId') productId: string) {
    return this.pricesService.findByProduct(productId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.pricesService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updatePriceDto: UpdatePriceDto) {
    return this.pricesService.update(id, updatePriceDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.pricesService.remove(id);
  }
}
