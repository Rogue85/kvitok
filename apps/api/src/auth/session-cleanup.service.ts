import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SessionCleanupService {
  constructor(private readonly prisma: PrismaService) {}

  async deleteExpired(now = new Date()): Promise<number> {
    const { count } = await this.prisma.session.deleteMany({ where: { expiresAt: { lte: now } } });
    return count;
  }
}
