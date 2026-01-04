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
import { PricesService } from './prices.service';
import { CreatePriceDto } from './dto/create-price.dto';
import { UpdatePriceDto } from './dto/update-price.dto';
import { FindAllPricesDto } from './dto/find-all-prices.dto';

@Controller('prices')
export class PricesController {
  constructor(private readonly pricesService: PricesService) {}

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
  getProductPriceDetail(@Param('productId') productId: string) {
    return this.pricesService.getProductPriceDetail(productId);
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
