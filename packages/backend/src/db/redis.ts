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
      retryStrategy: (times: number) => {
        if (times > 3) return null; // Stop retrying when Redis is not running locally
        return 2000;
      },
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
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy: (times: number) => {
        if (times > 3) return null;
        return 2000;
      },
    });
  }
}

export const redis = createRedisClient();

let lastRedisErrorLog = 0;
redis.on('error', (err: Error) => {
  const now = Date.now();
  if (now - lastRedisErrorLog > 30_000) {
    lastRedisErrorLog = now;
    console.warn('[REDIS] Optional cache service not running locally:', err.message);
  }
});
