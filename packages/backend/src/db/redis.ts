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
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy: (times: number) => Math.min(times * 500, 30_000),
    };
    
    if (isTls) {
      options.tls = {
        servername: parsed.hostname,
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

let lastRedisErrorLog = 0;
redis.on('error', (err: Error) => {
  const now = Date.now();
  if (now - lastRedisErrorLog > 30_000) {
    lastRedisErrorLog = now;
    console.error('[REDIS] Connection warning:', err.message, '(Verify REDIS_URL in environment)');
  }
});
