import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type IORedis from 'ioredis';
import { Public } from '../auth/decorators';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

type CheckStatus = 'ok' | 'error';

export interface HealthResponse {
  status: CheckStatus;
  /** The running release, for bug reports and for checking an update went through. */
  version: string;
  checks: { database: CheckStatus; redis: CheckStatus };
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: IORedis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get()
  async check(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthResponse> {
    const [database, redis] = await Promise.all([
      this.probe(() => this.prisma.$queryRaw`SELECT 1`),
      this.probe(() => this.redis.ping()),
    ]);
    const status: CheckStatus = database === 'ok' && redis === 'ok' ? 'ok' : 'error';
    if (status === 'error') {
      reply.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status, version: this.config.version, checks: { database, redis } };
  }

  private async probe(fn: () => Promise<unknown>): Promise<CheckStatus> {
    try {
      await fn();
      return 'ok';
    } catch {
      return 'error';
    }
  }
}
