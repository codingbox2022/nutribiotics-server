# Ingestion Runs Module

This module tracks price ingestion jobs that scan products across marketplaces, storing detailed information about each run and its results.

## Collection: `ingestion_runs`

MongoDB collection that stores comprehensive data about price comparison jobs.

### Schema Fields

#### Job Metadata
- `_id` — ObjectId (auto-generated)
- `status` — String: `pending`, `running`, `completed`, `failed`, `cancelled`
- `triggeredBy` — String: User ID or `"system"` for scheduled runs
- `triggeredAt` — Date: When the job was requested
- `startedAt` — Date: When processing began (optional)
- `completedAt` — Date: When the job finished (optional)
- `failedAt` — Date: When the job failed (optional)

#### Progress Tracking
- `totalProducts` — Number: Products to process
- `processedProducts` — Number: Products already processed
- `totalLookups` — Number: Total product-marketplace combinations
- `completedLookups` — Number: Successful lookups
- `failedLookups` — Number: Failed lookups
- `productsWithPrices` — Number: Products with at least one price found (optional)
- `productsNotFound` — Number: Products not found anywhere (optional)

#### Lookup Results
- `results` — Array of lookup result objects:
  - `productId` — ObjectId (reference)
  - `productName` — String (denormalized)
  - `marketplaceId` — ObjectId (reference)
  - `marketplaceName` — String (denormalized)
  - `url` — String: Full URL checked
  - `price` — Number (optional)
  - `currency` — String: e.g., "COP", "USD" (optional)
  - `inStock` — Boolean (optional)
  - `scrapedAt` — Date: When lookup happened
  - `lookupStatus` — String: `success`, `not_found`, `error`
  - `errorMessage` — String (optional)

#### Error Tracking
- `errorMessage` — String: Job-level error message (optional)
- `errorStack` — String: Stack trace for debugging (optional)

## API Endpoints

### Get All Runs (Paginated)
```bash
GET /ingestion-runs?page=1&limit=10
```

Response:
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 50,
    "totalPages": 5
  }
}
```

### Get Recent Runs
```bash
GET /ingestion-runs/recent?limit=5
```

### Get Runs by Status
```bash
GET /ingestion-runs/status/running
GET /ingestion-runs/status/completed
GET /ingestion-runs/status/failed
```

### Get Run by ID
```bash
GET /ingestion-runs/:id
```

### Cancel a Run
```bash
POST /ingestion-runs/:id/cancel
```
Only works for `pending` or `running` jobs.

## Service Usage

### Create a New Run
```typescript
import { IngestionRunsService } from './ingestion-runs/ingestion-runs.service';

const run = await ingestionRunsService.create(
  'user-id-123',  // triggeredBy
  150,            // totalProducts
  750             // totalLookups (150 products × 5 marketplaces)
);
```

### Mark as Running
```typescript
await ingestionRunsService.markAsRunning(run._id);
```

### Add Lookup Results
```typescript
await ingestionRunsService.addLookupResult(run._id, {
  productId: new Types.ObjectId('...'),
  productName: 'Product Name',
  marketplaceId: new Types.ObjectId('...'),
  marketplaceName: 'Amazon',
  url: 'https://amazon.com/product',
  price: 29990,
  currency: 'COP',
  inStock: true,
  scrapedAt: new Date(),
  lookupStatus: 'success',
});
```

### Update Progress
```typescript
await ingestionRunsService.updateProgress(run._id, 75); // 75 products processed
```

### Mark as Completed
```typescript
await ingestionRunsService.markAsCompleted(run._id);
// Automatically calculates productsWithPrices and productsNotFound
```

### Mark as Failed
```typescript
await ingestionRunsService.markAsFailed(
  run._id,
  'Connection timeout',
  error.stack
);
```

### Cancel a Run
```typescript
await ingestionRunsService.cancel(run._id);
```

## Integration with Price Comparison Queue

The price comparison processor automatically:
1. Creates an ingestion run when starting
2. Updates progress during execution
3. Adds lookup results for each scraped product
4. Marks the run as completed or failed

Example from `price-comparison.processor.ts`:
```typescript
// Create run
const run = await this.ingestionRunsService.create('user', 150, 750);
await this.ingestionRunsService.markAsRunning(run._id);

// Add results
await this.ingestionRunsService.addLookupResult(run._id, {
  // ... lookup result data
});

// Complete
await this.ingestionRunsService.markAsCompleted(run._id);
```

## Monitoring

All ingestion runs can be monitored through:
1. **API endpoints** - Get current status, view history
2. **MongoDB directly** - Query the `ingestion_runs` collection
3. **Bull Board** - View the queue jobs at `/queues`

## Status Flow

```
pending → running → completed
                 ↘ failed
                 ↘ cancelled
```

- `pending`: Job created but not started
- `running`: Currently processing
- `completed`: Successfully finished
- `failed`: Encountered an error
- `cancelled`: Manually stopped by user
