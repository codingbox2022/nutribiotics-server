import { Controller, Get } from '@nestjs/common';
import { StatsService } from './stats.service';

@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('login')
  getLoginStats() {
    return this.statsService.getLoginStats();
  }
}
