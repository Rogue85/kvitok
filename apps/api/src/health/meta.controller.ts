import { Controller, Get, Inject } from '@nestjs/common';
import type { Locale } from '@kvitok/i18n';
import { Public } from '../auth/decorators';
import { APP_CONFIG, type AppConfig } from '../config/env';

export interface MetaResponse {
  /** Interface language of the installation (APP_LOCALE); the web app loads it before rendering. */
  locale: Locale;
}

@Controller('meta')
export class MetaController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Public()
  @Get()
  meta(): MetaResponse {
    return { locale: this.config.locale };
  }
}
