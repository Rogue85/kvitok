import 'dotenv/config';
import { setLocale } from '@kvitok/i18n';
import { configureValidationLocale } from '@kvitok/shared';
import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './env';

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => {
        const config = loadConfig();
        // One language per installation: messages of the API, validation and system texts follow it.
        setLocale(config.locale);
        configureValidationLocale(config.locale);
        return config;
      },
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
