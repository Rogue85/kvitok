import { z } from 'zod';

export const AUDIT_ENTITIES = [
  'workspace',
  'member',
  'department',
  'field',
  'agent_settings',
  'llm_provider',
  'playbook',
  'routing_rule',
  'channel',
  'integration',
] as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'sync',
  'rotate_key',
  'rotate_webhook_secret',
  'set_default_mailbox',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditActorType = 'user' | 'token' | 'system';

export const AuditQuerySchema = z.object({
  entity: z.enum(AUDIT_ENTITIES).optional(),
  entityId: z.string().min(1).optional(),
  /** The id of the last entry of the previous page: the next page starts after it. */
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.output<typeof AuditQuerySchema>;

export interface AuditLogDto {
  id: string;
  entity: AuditEntity;
  entityId: string | null;
  action: AuditAction;
  actor: {
    type: AuditActorType;
    userId: string | null;
    name: string | null;
    tokenName: string | null;
  };
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}
