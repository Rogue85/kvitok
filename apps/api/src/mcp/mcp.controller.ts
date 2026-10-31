import { t } from '@kvitok/i18n';
import { Controller, Delete, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage } from 'node:http';
import type { FastifyReply } from 'fastify';
import { RequireScope } from '../auth/decorators';
import { errors } from '../common/errors';
import type { AppRequest } from '../common/request';
import { McpServerFactory } from './mcp-server.factory';

/**
 * The MCP endpoint for external agents (Streamable HTTP, stateless, JSON responses).
 * Only personal access tokens (`Authorization: Bearer`), not sessions: the token's scopes decide which tools exist,
 * and every tool checks the workspace role.
 */
@Controller('mcp')
export class McpController {
  constructor(private readonly servers: McpServerFactory) {}

  @Post()
  @RequireScope('read')
  async handle(@Req() request: AppRequest, @Res() reply: FastifyReply): Promise<void> {
    if (request.auth?.token == null) {
      throw errors.forbidden(t('api.mcpNeedsToken'));
    }
    const server = this.servers.create(request.auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    acceptJsonAndStream(request.raw);
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  }

  /** No server-initiated stream. */
  @Get()
  @HttpCode(405)
  stream(@Res({ passthrough: true }) reply: FastifyReply) {
    return methodNotAllowed(reply);
  }

  /** No sessions to end. */
  @Delete()
  @RequireScope('read')
  @HttpCode(405)
  endSession(@Res({ passthrough: true }) reply: FastifyReply) {
    return methodNotAllowed(reply);
  }
}

function methodNotAllowed(reply: FastifyReply) {
  reply.header('allow', 'POST');
  return { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: use POST' }, id: null };
}

/**
 * The transport insists on both types in Accept, but proxies (the web app's /api proxy among them) rewrite the header.
 * The response here is always JSON, so the header is set for the transport, which reads `rawHeaders`.
 */
function acceptJsonAndStream(raw: IncomingMessage): void {
  const value = 'application/json, text/event-stream';
  const headers: string[] = [];
  for (let i = 0; i < raw.rawHeaders.length; i += 2) {
    if (raw.rawHeaders[i]!.toLowerCase() !== 'accept') headers.push(raw.rawHeaders[i]!, raw.rawHeaders[i + 1]!);
  }
  raw.rawHeaders = [...headers, 'accept', value];
  raw.headers.accept = value;
}
