# Queue System Documentation

This project uses **BullMQ** with **Redis** for job queuing and background processing.

## Setup

### 1. Redis Installation

Install Redis locally:

```bash
# macOS
brew install redis
brew services start redis

# Ubuntu/Debian
sudo apt-get install redis-server
sudo systemctl start redis

# Windows (using WSL or Docker)
docker run -d -p 6379:6379 redis:alpine
```

### 2. Environment Variables

Add to your `.env` file:

```env
REDIS_HOST=localhost
REDIS_PORT=6379
```

## Usage

### Add a Job to the Queue

```typescript
import { NotificationsService } from './queues/notifications.service';

@Injectable()
export class YourService {
  constructor(private notificationsService: NotificationsService) {}

  async sendEmail() {
    await this.notificationsService.sendNotification({
      userId: '123',
      type: 'email',
      message: 'Welcome to our platform!',
      metadata: { subject: 'Welcome' }
    });
  }
}
```

### Schedule a Delayed Job

```typescript
// Send notification after 5 minutes
await this.notificationsService.scheduleNotification(
  {
    userId: '123',
    type: 'email',
    message: 'Reminder notification'
  },
  5 * 60 * 1000 // 5 minutes in milliseconds
);
```

### API Endpoints

**Add notification to queue:**
```bash
POST http://localhost:3000/queues/notifications
{
  "userId": "123",
  "type": "email",
  "message": "Test notification",
  "metadata": { "custom": "data" }
}
```

**Schedule notification:**
```bash
POST http://localhost:3000/queues/notifications/scheduled
{
  "data": {
    "userId": "123",
    "type": "sms",
    "message": "Scheduled notification"
  },
  "delayInMs": 60000
}
```

**Get queue metrics:**
```bash
GET http://localhost:3000/queues/metrics
```

**Trigger price comparison:**
```bash
POST http://localhost:3000/queues/price-comparison
```
This endpoint triggers an asynchronous job that:
1. Fetches all products from database
2. Scrapes competitor prices from marketplaces
3. Analyzes price differences and calculates indexes
4. Updates the database with comparison results

The job runs in the background and takes approximately 9 seconds to complete.

## Bull Board Dashboard

Access the queue monitoring dashboard at:
```
http://localhost:3000/queues
```

This provides a web UI to:
- View active, waiting, completed, and failed jobs
- Retry failed jobs
- Monitor queue performance
- Inspect job details

## Creating New Queues

1. Create a processor:
```typescript
// src/queues/my-queue.processor.ts
@Processor('my-queue')
export class MyQueueProcessor extends WorkerHost {
  async process(job: Job) {
    // Process job here
  }
}
```

2. Register in `queues.module.ts`:
```typescript
BullModule.registerQueue({
  name: 'my-queue',
}),
```

3. Create a service to add jobs to the queue
4. Add the queue to Bull Board for monitoring

## Features

- **Automatic retries** with exponential backoff
- **Job prioritization** (lower number = higher priority)
- **Delayed jobs** for scheduling
- **Job persistence** (survives server restarts)
- **Monitoring dashboard** with Bull Board
- **Metrics and analytics**
- **Concurrency control**
- **Rate limiting**

## Configuration

Default queue options in `queues.module.ts`:
- `attempts: 3` - Retry failed jobs 3 times
- `backoff: exponential` - Exponential backoff strategy
- `removeOnComplete: 100` - Keep last 100 completed jobs
- `removeOnFail: 500` - Keep last 500 failed jobs
