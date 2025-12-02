import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MarketplacesService } from './marketplaces.service';
import { CreateMarketplaceDto } from './dto/create-marketplace.dto';
import { UpdateMarketplaceDto } from './dto/update-marketplace.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('marketplaces')
@UseGuards(JwtAuthGuard)
export class MarketplacesController {
  constructor(private readonly marketplacesService: MarketplacesService) {}

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
}
