import 'reflect-metadata';
import { createApp } from './app.factory';
import { APP_CONFIG, type AppConfig } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
