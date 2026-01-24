import { Body, Controller, Get, Param, Post, Query, Request } from '@nestjs/common';
import { RecommendationsService } from './recommendations.service';

@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly recommendationsService: RecommendationsService) {}

  @Get('latest/:productId')
  getLatestByProduct(
    @Param('productId') productId: string,
    @Query('ingestionRunId') ingestionRunId?: string,
  ) {
    return this.recommendationsService.getLatestRecommendationForProduct(productId, ingestionRunId);
  }

  @Post(':id/accept')
  accept(@Param('id') id: string, @Request() req) {
    return this.recommendationsService.acceptRecommendation(id, req.user);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Request() req) {
    return this.recommendationsService.rejectRecommendation(id, req.user);
  }

  @Post('bulk-accept')
  bulkAccept(@Body() body: { recommendationIds: string[] }, @Request() req) {
    return this.recommendationsService.bulkAcceptRecommendations(body.recommendationIds, req.user);
  }
}
