import { newId } from '../common/ids';
import { json } from '../common/json';
import type { Prisma } from '../generated/prisma/client';

export type ActorType = 'user' | 'system' | 'channel' | 'rule' | 'agent';

export interface Actor {
  type: ActorType;
  id?: string | null;
}

export const SYSTEM_ACTOR: Actor = { type: 'system' };

export async function recordEvent(
  db: Prisma.TransactionClient,
  params: { workspaceId: string; ticketId: string; type: string; actor: Actor; data?: Record<string, unknown>; at?: Date },
): Promise<void> {
  await db.ticketEvent.create({
    data: {
      id: newId(),
      workspaceId: params.workspaceId,
      ticketId: params.ticketId,
      type: params.type,
      actorType: params.actor.type,
      actorId: params.actor.id ?? null,
      data: json(params.data ?? {}),
      ...(params.at ? { createdAt: params.at } : {}),
    },
  });
}
