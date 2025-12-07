import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationJobData } from './notifications.processor';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectQueue('notifications')
    private readonly notificationsQueue: Queue<NotificationJobData>,
  ) {}

  /**
   * Add a notification job to the queue
   */
  async sendNotification(data: NotificationJobData): Promise<void> {
    try {
      const job = await this.notificationsQueue.add('send-notification', data, {
        priority: this.getPriority(data.type),
      });
      this.logger.log(`Notification job ${job.id} added to queue`);
    } catch (error) {
      this.logger.error(`Failed to add notification job: ${error.message}`);
      throw error;
    }
  }

  /**
   * Schedule a delayed notification
   */
  async scheduleNotification(
    data: NotificationJobData,
    delayInMs: number,
  ): Promise<void> {
    try {
      const job = await this.notificationsQueue.add('send-notification', data, {
        delay: delayInMs,
        priority: this.getPriority(data.type),
      });
      this.logger.log(
        `Delayed notification job ${job.id} scheduled for ${delayInMs}ms`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to schedule notification job: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Get queue metrics
   */
  async getQueueMetrics() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.notificationsQueue.getWaitingCount(),
      this.notificationsQueue.getActiveCount(),
      this.notificationsQueue.getCompletedCount(),
      this.notificationsQueue.getFailedCount(),
      this.notificationsQueue.getDelayedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
    };
  }

  private getPriority(type: NotificationJobData['type']): number {
    const priorityMap = {
      email: 2,
      sms: 1,
      push: 3,
    };
    return priorityMap[type] || 5;
  }
}
