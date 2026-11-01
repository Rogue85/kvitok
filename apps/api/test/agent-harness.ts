import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AgentCoreModule } from '../src/agent/agent-core.module';
import { AgentEngine } from '../src/agent/agent-engine';
import { AuditModule } from '../src/audit/audit.module';
import { ConfigModule } from '../src/config/config.module';
import { CryptoModule } from '../src/crypto/crypto.module';
import { LLM_CLIENT_FACTORY } from '../src/llm/llm-client.factory';
import type { LlmClient, LlmRequest, LlmResponse } from '../src/llm/llm.types';
import { NotificationsModule } from '../src/notifications/notifications.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { QueueRootModule } from '../src/queue.module';
import { RealtimeModule } from '../src/realtime/realtime.module';
import { RedisModule } from '../src/redis/redis.module';
import { StorageModule } from '../src/storage/storage.module';
import { ScriptedLlm } from './support/scripted-llm';

/** The agent engine without the BullMQ processor: the test starts runs itself; the LLM is scripted. */
export interface AgentHarness {
  context: INestApplicationContext;
  engine: AgentEngine;
  /** The current LLM script; replace it between tests. */
  llm: ScriptedLlm;
  setLlm(llm: ScriptedLlm): void;
  client: LlmClient;
}

export async function createAgentHarness(): Promise<AgentHarness> {
  const harness = { llm: new ScriptedLlm() } as AgentHarness;
  const client: LlmClient = { chat: (request: LlmRequest): Promise<LlmResponse> => harness.llm.chat(request) };

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, CryptoModule, PrismaModule, AuditModule, RedisModule, QueueRootModule, RealtimeModule, NotificationsModule, StorageModule, AgentCoreModule],
  })
    .overrideProvider(LLM_CLIENT_FACTORY)
    .useValue(() => client)
    .compile();
  const context = await moduleRef.init();

  harness.context = context;
  harness.engine = context.get(AgentEngine);
  harness.client = client;
  harness.setLlm = (llm) => {
    harness.llm = llm;
  };
  return harness;
}
