import { z } from 'zod';
import type { ActionProposalDto } from './actions.js';
import type { TicketCostDto } from './analytics.js';
import { patchOf } from './patch.js';
import { FieldKeySchema } from './fields.js';

/* LLM providers */

export const LlmModelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  /** Price per million tokens in the workspace currency — to compute the cost of runs. */
  inputPerMillion: z.number().min(0).optional(),
  outputPerMillion: z.number().min(0).optional(),
});
export type LlmModel = z.infer<typeof LlmModelSchema>;

export const LlmCapabilitiesSchema = z.object({
  /** Supports tool calling (`tools` in chat/completions). Without it the agent works in JSON mode. */
  tools: z.boolean().default(true),
  vision: z.boolean().default(false),
});
export type LlmCapabilities = z.infer<typeof LlmCapabilitiesSchema>;

const LlmProviderBase = z.object({
  name: z.string().trim().min(1).max(120),
  baseUrl: z.url(),
  /** May be omitted on update — the current one stays. */
  apiKey: z.string().max(2000).optional(),
  models: z.array(LlmModelSchema).max(50).default([]),
  capabilities: LlmCapabilitiesSchema.default({ tools: true, vision: false }),
});
export const CreateLlmProviderSchema = LlmProviderBase;
export type CreateLlmProviderInput = z.input<typeof CreateLlmProviderSchema>;
export const UpdateLlmProviderSchema = patchOf(LlmProviderBase);
export type UpdateLlmProviderInput = z.input<typeof UpdateLlmProviderSchema>;

export interface LlmProviderDto {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  hasApiKey: boolean;
  models: LlmModel[];
  capabilities: LlmCapabilities;
}

/* Agent settings */

export const PLAYBOOK_MODES = ['on_demand', 'inline'] as const;

export const AgentSettingsSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().nullable(),
  model: z.string().trim().max(200).nullable(),
  policy: z.string().max(50_000),
  playbookMode: z.enum(PLAYBOOK_MODES),
  maxToolCalls: z.number().int().min(1).max(30),
  maxOutputTokens: z.number().int().min(256).max(32_000),
  temperature: z.number().min(0).max(2),
  confidenceThreshold: z.number().min(0).max(1),
  debounceSeconds: z.number().int().min(0).max(600),
});
export type AgentSettingsDto = z.infer<typeof AgentSettingsSchema>;
export const UpdateAgentSettingsSchema = AgentSettingsSchema.partial();
export type UpdateAgentSettingsInput = z.infer<typeof UpdateAgentSettingsSchema>;

/* Playbooks */

const PlaybookBase = z.object({
  title: z.string().trim().min(1).max(200),
  when: z.string().trim().min(1).max(1000),
  body: z.string().trim().min(1).max(50_000),
  departmentId: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
});
export const CreatePlaybookSchema = PlaybookBase.extend({ key: FieldKeySchema });
export type CreatePlaybookInput = z.input<typeof CreatePlaybookSchema>;
export const UpdatePlaybookSchema = patchOf(PlaybookBase);
export type UpdatePlaybookInput = z.input<typeof UpdatePlaybookSchema>;

export interface PlaybookDto {
  id: string;
  key: string;
  title: string;
  when: string;
  body: string;
  departmentId: string | null;
  /** ui — written in the interface; manifest — came from an integration, edited in its backend, can only be disabled. */
  source: string;
  integrationId: string | null;
  enabled: boolean;
  version: number;
}

/* Analysis result */

export interface FieldSuggestion {
  value: unknown;
  confidence: number;
  evidence: string | null;
  /** Why it was not applied automatically. */
  reason: 'suggest_mode' | 'low_confidence' | 'locked' | 'filled_by_other_source';
}

export interface TicketAnalysis {
  runId: string;
  at: string;
  /** Key of the department the agent chose (null — it could not). */
  department: string | null;
  confidence: number;
  routingReason: string;
  alternativeDepartment: string | null;
  summary: string;
  findings: string[];
  needsHuman: boolean;
  playbooksUsed: string[];
  /** The agent thinks another department fits, but the department is pinned or the ticket is already taken. */
  departmentSuggestion: { departmentId: string; confidence: number; reason: string } | null;
  /** The ticket went to the triage department: low confidence, needs_human or an unknown department. */
  sentToTriage: boolean;
  fieldSuggestions: Record<string, FieldSuggestion>;
}

export type AgentState = 'idle' | 'queued' | 'running' | 'failed';
export type AgentRunMode = 'triage' | 'refine';
export type AgentRunStatus = 'queued' | 'running' | 'applied' | 'stale' | 'failed' | 'cancelled';

export interface AgentRunDto {
  id: string;
  mode: AgentRunMode;
  status: AgentRunStatus;
  dryRun: boolean;
  trigger: { type: string; messageId?: string; userId?: string; instruction?: string };
  model: string | null;
  configVersion: number | null;
  error: string | null;
  tokensIn: number;
  tokensOut: number;
  /** In the workspace currency; null — the model has no price. */
  cost: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AgentStepDto {
  index: number;
  kind: 'llm' | 'tool';
  name: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
}

export interface AgentRunDetailDto extends AgentRunDto {
  steps: AgentStepDto[];
  output: unknown;
  inputSnapshot: unknown;
}

export interface AgentQuestionDto {
  id: string;
  text: string;
  status: 'open' | 'answered' | 'dismissed';
  runId: string;
  createdAt: string;
}

export interface ReplyDraftDto {
  id: string;
  version: number;
  source: 'agent' | 'operator';
  status: 'current' | 'suggested' | 'superseded' | 'sent' | 'discarded';
  bodyHtml: string;
  runId: string | null;
  createdAt: string;
}

/** Data of the `agent_analyzed` event: the timeline builds the agent message from it. Older events may lack some fields. */
export interface AgentAnalyzedEventData {
  runId: string;
  mode: AgentRunMode;
  /** Reply to the operator in the ticket chat; empty — the agent has nothing to say. */
  message?: string;
  /** false — a partial run did not change the analysis (summary, department, findings). */
  analysisUpdated?: boolean;
  summary?: string;
  findings?: string[];
  department: string | null;
  confidence: number;
  sentToTriage: boolean;
  needsHuman?: boolean;
  questions?: Array<{ id: string; text: string }>;
  /** The run stored a new version of the reply draft. */
  replyUpdated?: boolean;
  /** Actions proposed by this run (their current status is in TicketAgentDto.actions). */
  actions?: Array<{ id: string; title: string; preview: string | null }>;
}

export interface TicketAgentDto {
  enabled: boolean;
  state: AgentState;
  analysis: TicketAnalysis | null;
  questions: AgentQuestionDto[];
  /** The current draft in the composer (the agent's or the operator's). */
  draft: ReplyDraftDto | null;
  /** A new version from the agent while the operator has unsent edits of their own. */
  suggestedDraft: ReplyDraftDto | null;
  /** The latest runs. */
  runs: AgentRunDto[];
  /** What all runs on the ticket cost. */
  cost: TicketCostDto;
  /** Proposed actions of all runs, newest last. */
  actions: ActionProposalDto[];
}

export const RunAgentSchema = z.object({
  mode: z.enum(['triage', 'refine']).default('refine'),
});

export const DryRunSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().trim().min(1).max(200).optional(),
});
export type DryRunInput = z.infer<typeof DryRunSchema>;

export const SaveDraftSchema = z.object({
  bodyHtml: z.string().max(500_000),
});

export const AnswerQuestionSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
});

export const AcceptSuggestionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('field'), key: z.string() }),
  z.object({ kind: z.literal('department') }),
]);
export type AcceptSuggestionInput = z.infer<typeof AcceptSuggestionSchema>;

export interface PromptPreviewDto {
  messages: Array<{ role: string; content: string }>;
  tools: Array<{ name: string; description: string; parameters: unknown }>;
  configVersion: number;
}
