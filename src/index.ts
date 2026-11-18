import { loadConfig } from './config/env.js';
import { createApp } from './app/create-app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, logger, lifecycleService } = await createApp({ config });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down UjjwalRouter gracefully');
    try {
      lifecycleService.stopBackgroundTasks();
      await app.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  logger.info(
    { host: config.host, port: config.port, strictFreeOnly: config.strictFreeOnly },
    'UjjwalRouter listening'
  );

  // Run initial model discovery and health checks asynchronously after bind
  void lifecycleService.refreshDiscoveryAndPersist().catch((err) => {
    logger.warn({ err }, 'Initial model discovery failed');
  });
  void lifecycleService.runHealthChecksAndPersist().catch((err) => {
    logger.warn({ err }, 'Initial health check failed');
  });
  lifecycleService.startBackgroundTasks();
}

main().catch((err) => {
  console.error('Failed to start UjjwalRouter:', err);
  process.exit(1);
});
