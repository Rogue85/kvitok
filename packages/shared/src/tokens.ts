import { z } from 'zod';

/**
 * What a personal access token may do. Reading covers every GET route the user can open;
 * a route that changes state is closed to tokens unless it names one of the other scopes.
 */
export const API_TOKEN_SCOPES = ['read', 'config:write', 'integrations:write', 'tickets:ingest', 'workspaces:create'] as const;

export const ApiTokenScopeSchema = z.enum(API_TOKEN_SCOPES);
export type ApiTokenScope = z.infer<typeof ApiTokenScopeSchema>;

/** Tokens start with it, so secret scanners and people can tell them apart. */
export const API_TOKEN_PREFIX = 'kvt_';

export const CreateApiTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(ApiTokenScopeSchema).min(1),
  /** Restricts the token to one workspace; null — every workspace of the user. */
  workspaceId: z.string().min(1).nullable().default(null),
  /** null — the token does not expire. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
});
export type CreateApiTokenInput = z.input<typeof CreateApiTokenSchema>;
export type CreateApiTokenData = z.output<typeof CreateApiTokenSchema>;

export interface ApiTokenDto {
  id: string;
  name: string;
  scopes: ApiTokenScope[];
  workspaceId: string | null;
  workspaceName: string | null;
  /** The last characters of the token. */
  hint: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/** The token itself is returned once, on creation. */
export interface CreatedApiTokenDto {
  token: ApiTokenDto;
  secret: string;
}
