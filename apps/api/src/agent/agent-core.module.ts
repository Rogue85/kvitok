import { Module } from '@nestjs/common';
import { FieldsModule } from '../fields/fields.module';
import { IdentificationModule } from '../identification/identification.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { RoutingModule } from '../routing/routing.module';
import { AgentConfigModule } from './agent-config.module';
import { AgentEngine } from './agent-engine';
import { AgentRunner } from './agent-runner';
import { AgentTriggerModule } from './agent-trigger.module';
import { DraftsService } from './drafts.service';
import { IntegrationRuntimeService } from './integration-runtime';
import { ResultApplier } from './result-applier';

/** The agent engine: needed by the worker (runs) and the API (trial run, drafts). */
@Module({
  imports: [AgentConfigModule, AgentTriggerModule, RoutingModule, IntegrationsModule, IdentificationModule, FieldsModule],
  providers: [AgentRunner, ResultApplier, DraftsService, IntegrationRuntimeService, AgentEngine],
  exports: [AgentEngine, DraftsService, IntegrationRuntimeService, AgentConfigModule, AgentTriggerModule, IntegrationsModule],
})
export class AgentCoreModule {}
