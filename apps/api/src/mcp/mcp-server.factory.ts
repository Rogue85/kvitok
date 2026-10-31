import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { McpCallContext, registerTools } from './mcp-tool';
import { registerPrompts } from './prompts';
import { registerResources, SERVER_INSTRUCTIONS } from './resources';
import { CheckTools } from './tools/check.tools';
import { ConfigTools } from './tools/config.tools';
import { ReadTools } from './tools/read.tools';

const SERVER_VERSION = '1.0.0';

/** A server per request: the transport is stateless, and the tool list depends on the caller's scopes. */
@Injectable()
export class McpServerFactory {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
    private readonly read: ReadTools,
    private readonly config: ConfigTools,
    private readonly checks: CheckTools,
  ) {}

  create(auth: AuthContext): McpServer {
    const server = new McpServer({ name: 'kvitok', version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
    const call = new McpCallContext(auth, this.prisma, this.workspaces);
    registerTools(server, call, [...this.read.specs(), ...this.config.specs(), ...this.checks.specs()]);
    registerResources(server);
    registerPrompts(server);
    return server;
  }
}
