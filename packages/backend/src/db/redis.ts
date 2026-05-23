import { Redis } from 'ioredis';
import { config } from '../config.js';

function createRedisClient(): Redis {
  const urlStr = config.REDIS_URL;
  try {
    const parsed = new URL(urlStr);
    const isTls = parsed.protocol === 'rediss:';
    
    const options: any = {
      host: parsed.hostname,
      port: Number(parsed.port) || 6379,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy: (times: number) => Math.min(times * 200, 30_000),
    };
    
    if (isTls) {
      options.tls = {
        rejectUnauthorized: false,
      };
    }
    
    return new Redis(options);
  } catch (e) {
    // Fallback to simple string-based initialization
    return new Redis(urlStr, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy: (times: number) => Math.min(times * 200, 30_000),
    });
  }
}

export const redis = createRedisClient();

redis.on('error', (err: Error) => {
  console.error('[REDIS] Connection error:', err.message);
});

redis.on('reconnecting', () => {
  console.warn('[REDIS] Reconnecting...');
});
