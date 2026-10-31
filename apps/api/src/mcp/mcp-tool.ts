import { HttpException, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { roleSatisfies, type ApiTokenScope, type ApiErrorBody, type WorkspaceRole } from '@kvitok/shared';
import { z } from 'zod';
import { errors } from '../common/errors';
import type { AuthContext } from '../common/request';
import type { PrismaService } from '../prisma/prisma.service';
import { workspaceRole } from '../workspaces/workspace.guard';
import type { WorkspacesService } from '../workspaces/workspaces.service';

/** An error meant for the external agent: the message says what to do instead. */
export class McpToolError extends Error {}

/** One MCP request on behalf of a user or a token. */
export class McpCallContext {
  constructor(
    readonly auth: AuthContext,
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
  ) {}

  /** MCP accepts only tokens (the controller checks it). */
  get scopes(): readonly ApiTokenScope[] {
    return this.auth.token?.scopes ?? [];
  }

  has(scope: ApiTokenScope): boolean {
    if (scope === 'workspaces:create' && !this.auth.user.isSuperadmin) return false;
    return this.scopes.includes(scope);
  }

  /** The workspace of the call: the requested one, the token's one or the user's only one; the role is checked. */
  async workspace(requested: string | undefined, required: WorkspaceRole): Promise<string> {
    const workspaceId = requested ?? this.auth.token?.workspaceId ?? (await this.onlyWorkspace());
    const role = await workspaceRole(this.prisma, this.auth, workspaceId);
    if (!roleSatisfies(role, required)) {
      throw errors.forbidden();
    }
    return workspaceId;
  }

  private async onlyWorkspace(): Promise<string> {
    const list = await this.workspaces.listFor(this.auth.user);
    if (list.length === 1) return list[0]!.id;
    throw new McpToolError('You have access to several workspaces: pass workspaceId (list_workspaces shows them).');
  }
}

export interface ToolRun {
  call: McpCallContext;
  /** Empty for tools that do not work inside a workspace. */
  workspaceId: string;
}

export interface ToolSpec<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  scope: ApiTokenScope;
  /** The minimum role in the workspace; null — the tool does not work inside a workspace. */
  role: WorkspaceRole | null;
  /** Changes nothing: the client may call it without asking. */
  readOnly?: boolean;
  /** Deletes or replaces something. */
  destructive?: boolean;
  run: (args: z.output<S>, ctx: ToolRun) => Promise<unknown>;
}

/** Keeps the argument types of `run` tied to the schema. */
export function tool<S extends z.ZodObject>(spec: ToolSpec<S>): ToolSpec {
  return spec as unknown as ToolSpec;
}

/** The arguments carry workspaceId for routing; the services take the rest. */
export function withoutWorkspace<T extends object>(input: T): Omit<T, 'workspaceId'> {
  const { workspaceId: _, ...rest } = input as T & { workspaceId?: string };
  return rest;
}

const WORKSPACE_ARG = z
  .string()
  .optional()
  .describe('Workspace id. Optional when the token is restricted to one workspace or the user has only one.');

const logger = new Logger('McpServer');

/** Registers the tools the caller's scopes allow; the others are not listed at all. */
export function registerTools(server: McpServer, call: McpCallContext, specs: ToolSpec[]): void {
  for (const spec of specs) {
    if (!call.has(spec.scope)) continue;
    const input = spec.role === null ? spec.input : spec.input.safeExtend({ workspaceId: WORKSPACE_ARG });
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: input,
        annotations: { readOnlyHint: spec.readOnly ?? false, destructiveHint: spec.destructive ?? false, openWorldHint: false },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          const workspaceId = spec.role === null ? '' : await call.workspace(args.workspaceId as string | undefined, spec.role);
          return ok(await spec.run(args as never, { call, workspaceId }));
        } catch (error) {
          return fail(spec.name, error);
        }
      },
    );
  }
}

function ok(result: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? { ok: true }) }] };
}

function fail(name: string, error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: errorText(error, name) }] };
}

/** What the external agent sees of an error: our messages and API errors as they are, anything else logged and hidden. */
export function errorText(error: unknown, context: string): string {
  if (error instanceof McpToolError) return error.message;
  if (error instanceof HttpException) {
    const body = error.getResponse() as ApiErrorBody | string;
    return typeof body === 'string' ? body : JSON.stringify(body.error);
  }
  logger.error(`${context} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  return 'Internal error';
}
