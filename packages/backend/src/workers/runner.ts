import { Worker } from 'bullmq';
import { redis } from '../db/redis.js';
import { processPiiRedaction } from './pii-redaction.js';
import { processIntegrationDispatch } from './integration-dispatch.js';

console.info('[WORKER] BugBuddy worker starting...');

// ─── PII Redaction Worker ─────────────────────────────────────────────────────
const piiWorker = new Worker('pii-redaction', processPiiRedaction, {
  connection: redis,
  concurrency: 3,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
});

piiWorker.on('failed', (job, err) => {
  console.error(`[WORKER] pii-redaction job ${job?.id} failed:`, err.message);
});

// ─── Integration Dispatch Worker ──────────────────────────────────────────────
const integrationWorker = new Worker('integration-dispatch', processIntegrationDispatch, {
  connection: redis,
  concurrency: 5,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
});

integrationWorker.on('failed', (job, err) => {
  console.error(`[WORKER] integration-dispatch job ${job?.id} failed:`, err.message);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = async () => {
  console.info('[WORKER] Shutting down gracefully...');
  await Promise.all([piiWorker.close(), integrationWorker.close()]);
  await redis.quit();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
console.info('[WORKER] Workers started and listening for jobs');
