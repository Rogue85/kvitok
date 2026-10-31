import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { SecretBox } from './secret-box';

@Global()
@Module({
  providers: [{ provide: SecretBox, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new SecretBox(config.appSecret) }],
  exports: [SecretBox],
})
export class CryptoModule {}
