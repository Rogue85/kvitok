import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import IORedis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { redisOptionsFromUrl } from './redis-options';

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new IORedis({ ...redisOptionsFromUrl(config.redisUrl), maxRetriesPerRequest: null }),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: IORedis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
