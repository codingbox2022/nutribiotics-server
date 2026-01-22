import { Controller, Post, Body, Get } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationsService } from './notifications.service';
import type { NotificationJobData } from './notifications.processor';
import type { PriceComparisonJobData } from './price-comparison.processor';

@Controller('queues')
export class QueuesController {
  constructor(
    private readonly notificationsService: NotificationsService,
    @InjectQueue('price-comparison')
    private readonly priceComparisonQueue: Queue<PriceComparisonJobData>,
  ) {}

  @Post('notifications')
  async addNotification(@Body() data: NotificationJobData) {
    await this.notificationsService.sendNotification(data);
    return {
      message: 'Notification job added to queue',
      data,
    };
  }

  @Post('notifications/scheduled')
  async scheduleNotification(
    @Body() body: { data: NotificationJobData; delayInMs: number },
  ) {
    await this.notificationsService.scheduleNotification(
      body.data,
      body.delayInMs,
    );
    return {
      message: `Notification job scheduled for ${body.delayInMs}ms`,
      data: body.data,
    };
  }

  @Get('metrics')
  async getMetrics() {
    const metrics = await this.notificationsService.getQueueMetrics();
    return {
      queue: 'notifications',
      metrics,
    };
  }

  @Post('price-comparison')
  async startPriceComparison(@Body() body?: { productId?: string }) {
    const jobData: PriceComparisonJobData = {
      timestamp: new Date(),
      triggeredBy: 'user',
    };

    if (body?.productId) {
      jobData.productId = body.productId;
    }

    const job = await this.priceComparisonQueue.add('compare-prices', jobData);

    return {
      message: body?.productId
        ? 'Single product price comparison job started'
        : 'Price comparison job started',
      jobId: job.id,
      timestamp: new Date(),
      productId: body?.productId,
    };
  }
}