import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { LogLevel } from '@nestjs/common';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './config/env';

export function createFastifyAdapter(): FastifyAdapter {
  // forceCloseConnections: open SSE streams must not keep the process alive on shutdown.
  return new FastifyAdapter({ trustProxy: true, forceCloseConnections: true });
}

export async function configureApp(app: NestFastifyApplication): Promise<NestFastifyApplication> {
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.register(fastifyCookie, { secret: config.appSecret });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.webOrigin, credentials: true });
  app.enableShutdownHooks();
  return app;
}

export async function createApp(options: { logger?: LogLevel[] | false } = {}): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter(), {
    logger: options.logger ?? ['log', 'warn', 'error'],
  });
  return configureApp(app);
}
