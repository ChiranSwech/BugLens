import { Queue } from 'bullmq';
import { redis } from '../db/redis.js';

export const piiQueue = new Queue('pii-redaction', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  }
});

export const integrationQueue = new Queue('integration-dispatch', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  }
});
