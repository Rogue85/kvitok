import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    // The adapter passes dates without an offset, as UTC time. The session is in UTC — otherwise Postgres reads them
    // in its own time zone and the stored time ends up shifted (for SQL, reports and external readers).
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl, options: '-c timezone=UTC' }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
