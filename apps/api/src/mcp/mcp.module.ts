import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AgentConfigModule } from '../agent/agent-config.module';
import { AgentCoreModule } from '../agent/agent-core.module';
import { AgentModule } from '../agent/agent.module';
import { ChannelsModule } from '../channels/channels.module';
import { DepartmentsModule } from '../departments/departments.module';
import { FieldsModule } from '../fields/fields.module';
import { IdentificationModule } from '../identification/identification.module';
import { IngestModule } from '../ingest/ingest.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { RoutingModule } from '../routing/routing.module';
import { TicketsModule } from '../tickets/tickets.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { McpServerFactory } from './mcp-server.factory';
import { McpController } from './mcp.controller';
import { ReplayService } from './replay.service';
import { CheckTools } from './tools/check.tools';
import { ConfigTools } from './tools/config.tools';
import { ReadTools } from './tools/read.tools';

@Module({
  imports: [
    AgentModule,
    AgentCoreModule,
    AgentConfigModule,
    AnalyticsModule,
    ChannelsModule,
    DepartmentsModule,
    FieldsModule,
    IdentificationModule,
    IngestModule,
    IntegrationsModule,
    RoutingModule,
    TicketsModule,
    WorkspacesModule,
  ],
  controllers: [McpController],
  providers: [McpServerFactory, ReplayService, ReadTools, ConfigTools, CheckTools],
})
export class McpModule {}
