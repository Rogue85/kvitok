import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AdminModule } from './admin/admin.module';
import { AgentConfigModule } from './agent/agent-config.module';
import { AgentModule } from './agent/agent.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditContextInterceptor } from './audit/audit-context.interceptor';
import { AuditController } from './audit/audit.controller';
import { AuditModule } from './audit/audit.module';
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
import { McpModule } from './mcp/mcp.module';
import { IdentificationModule } from './identification/identification.module';
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
    AuditModule,
    RedisModule,
    QueueRootModule,
    StorageModule,
    RealtimeModule,
    AuthModule,
    UsersModule,
    WorkspacesModule,
    AdminModule,
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
    IdentificationModule,
    AgentModule,
    AnalyticsModule,
    McpModule,
  ],
  controllers: [HealthController, MetaController, AuditController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: AuditContextInterceptor },
  ],
})
export class AppModule {}
