import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

export interface NotificationJobData {
  userId: string;
  type: 'email' | 'sms' | 'push';
  message: string;
  metadata?: Record<string, any>;
}

@Processor('notifications')
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  async process(job: Job<NotificationJobData>): Promise<void> {
    this.logger.log(`Processing notification job ${job.id}`);
    const { userId, type, message, metadata } = job.data;

    try {
      // Simulate processing time
      await this.delay(1000);

      // Here you would implement actual notification logic
      // For example: send email, SMS, push notification, etc.
      this.logger.log(
        `Notification sent: ${type} to user ${userId} - ${message}`,
      );

      if (metadata) {
        this.logger.debug(`Metadata: ${JSON.stringify(metadata)}`);
      }

      // Update job progress
      await job.updateProgress(100);

      return;
    } catch (error) {
      this.logger.error(
        `Failed to process notification job ${job.id}: ${error.message}`,
      );
      throw error; // This will trigger retry logic
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
