import { Injectable } from '@nestjs/common';

const TTL_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class ExportCacheService {
  private readonly cache = new Map<
    string,
    { buffer: Buffer; createdAt: number }
  >();

  set(jobId: string, buffer: Buffer): void {
    this.cache.set(jobId, { buffer, createdAt: Date.now() });
  }

  get(jobId: string): Buffer | null {
    const entry = this.cache.get(jobId);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > TTL_MS) {
      this.cache.delete(jobId);
      return null;
    }
    const buffer = entry.buffer;
    this.cache.delete(jobId); // one-time download
    return buffer;
  }
}
