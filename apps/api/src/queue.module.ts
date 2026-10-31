import { BullModule } from '@nestjs/bullmq';
import { APP_CONFIG, type AppConfig } from './config/env';
import { redisOptionsFromUrl } from './redis/redis-options';

/** Connects BullMQ to Redis from the config. */
export const QueueRootModule = BullModule.forRootAsync({
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig) => ({
    prefix: config.queuePrefix,
    connection: { ...redisOptionsFromUrl(config.redisUrl), maxRetriesPerRequest: null },
  }),
});
