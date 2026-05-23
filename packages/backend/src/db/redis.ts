import { Redis } from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
  // Reconnect with exponential backoff (cap at 30s)
  retryStrategy: (times: number) => Math.min(times * 200, 30_000),
});

redis.on('error', (err: Error) => {
  console.error('[REDIS] Connection error:', err.message);
});

redis.on('reconnecting', () => {
  console.warn('[REDIS] Reconnecting...');
});
