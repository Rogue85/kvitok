import { Module } from '@nestjs/common';
import { DepartmentsModule } from '../departments/departments.module';
import { FieldsModule } from '../fields/fields.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { defaultLlmClientFactory, LLM_CLIENT_FACTORY } from '../llm/llm-client.factory';
import { AgentConfigController } from './agent-config.controller';
import { AgentSettingsService } from './agent-settings.service';
import { ConfigSnapshotService } from './config-snapshot.service';
import { LlmProvidersService } from './llm-providers.service';
import { PlaybooksService } from './playbooks.service';

@Module({
  imports: [DepartmentsModule, FieldsModule, IntegrationsModule],
  controllers: [AgentConfigController],
  providers: [
    { provide: LLM_CLIENT_FACTORY, useValue: defaultLlmClientFactory },
    AgentSettingsService,
    LlmProvidersService,
    PlaybooksService,
    ConfigSnapshotService,
  ],
  exports: [AgentSettingsService, LlmProvidersService, PlaybooksService, ConfigSnapshotService, LLM_CLIENT_FACTORY],
})
export class AgentConfigModule {}
