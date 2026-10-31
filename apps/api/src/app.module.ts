import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AgentConfigModule } from './agent/agent-config.module';
import { AgentModule } from './agent/agent.module';
import { AuthModule } from './auth/auth.module';
import { ChannelsModule } from './channels/channels.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { ConfigModule } from './config/config.module';
import { ConversationModule } from './conversation/conversation.module';
import { CryptoModule } from './crypto/crypto.module';
import { DepartmentsModule } from './departments/departments.module';
import { FieldsModule } from './fields/fields.module';
import { HealthController } from './health/health.controller';
import { MetaController } from './health/meta.controller';
import { MailModule } from './mail/mail.module';
import { IngestModule } from './ingest/ingest.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { QueueRootModule } from './queue.module';
import { RealtimeModule } from './realtime/realtime.module';
import { TicketsModule } from './tickets/tickets.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { RoutingModule } from './routing/routing.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [
    ConfigModule,
    CryptoModule,
    PrismaModule,
    RedisModule,
    QueueRootModule,
    StorageModule,
    RealtimeModule,
    AuthModule,
    UsersModule,
    WorkspacesModule,
    FieldsModule,
    DepartmentsModule,
    ChannelsModule,
    TicketsModule,
    IngestModule,
    ConversationModule,
    MailModule,
    AgentConfigModule,
    IntegrationsModule,
    RoutingModule,
    AgentModule,
  ],
  controllers: [HealthController, MetaController],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
