import { Module } from '@nestjs/common';
import { ActionsWorkerModule } from './actions/actions.processor';
import { AgentWorkerModule } from './agent/agent.processor';
import { ConfigModule } from './config/config.module';
import { CryptoModule } from './crypto/crypto.module';
import { MailWorkerModule } from './mail/mail-worker.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { OutboundWorkerModule } from './outbound/outbound-worker.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueRootModule } from './queue.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule,
    CryptoModule,
    PrismaModule,
    RedisModule,
    QueueRootModule,
    RealtimeModule,
    StorageModule,
    MaintenanceModule,
    OutboundWorkerModule,
    MailWorkerModule,
    AgentWorkerModule,
    ActionsWorkerModule,
  ],
})
export class WorkerModule {}
