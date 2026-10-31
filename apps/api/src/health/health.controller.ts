import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type IORedis from 'ioredis';
import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

type CheckStatus = 'ok' | 'error';

export interface HealthResponse {
  status: CheckStatus;
  checks: { database: CheckStatus; redis: CheckStatus };
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: IORedis,
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
    return { status, checks: { database, redis } };
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
