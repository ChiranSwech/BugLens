import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { redis } from './db/redis.js';

const app = await buildApp();

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = async (signal: string) => {
  app.log.info(`[SERVER] Received ${signal}. Shutting down gracefully...`);
  try {
    await app.close();
    await pool.end();
    await redis.quit();
    app.log.info('[SERVER] Shutdown complete.');
    process.exit(0);
  } catch (err) {
    app.log.error(err, '[SERVER] Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Unhandled rejection guard ────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, '[SERVER] Unhandled promise rejection — shutting down');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  app.log.error({ error }, '[SERVER] Uncaught exception — shutting down');
  process.exit(1);
});

// ─── Start ────────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info(`[SERVER] BugBuddy API running on port ${config.PORT}`);
} catch (err) {
  app.log.error(err, '[SERVER] Failed to start');
  process.exit(1);
}
