import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp, createApp, createFastifyAdapter } from '../src/app.factory';
import { LLM_CLIENT_FACTORY, type LlmClientFactory } from '../src/llm/llm-client.factory';
import { newId } from '../src/common/ids';
import { PrismaService } from '../src/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';
import type { WorkspaceRole } from '@kvitok/shared';

export async function createTestApp(options: { llm?: LlmClientFactory } = {}): Promise<NestFastifyApplication> {
  let app: NestFastifyApplication;
  if (options.llm) {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_CLIENT_FACTORY)
      .useValue(options.llm)
      .compile();
    app = await configureApp(moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), { logger: false }));
  } else {
    app = await createApp({ logger: false });
  }
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

export async function resetDb(app: NestFastifyApplication): Promise<void> {
  const prisma = app.get(PrismaService);
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
  }
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

let counter = 0;

export async function createUser(
  app: NestFastifyApplication,
  overrides: { email?: string; password?: string; superadmin?: boolean } = {},
): Promise<TestUser> {
  counter += 1;
  const email = overrides.email ?? `user${counter}@example.com`;
  const password = overrides.password ?? 'password123';
  const user = await app.get(UsersService).create({
    email,
    password,
    name: `User ${counter}`,
    isSuperadmin: overrides.superadmin ?? false,
  });
  return { id: user.id, email, password };
}

export async function createWorkspace(
  app: NestFastifyApplication,
  members: Array<{ user: TestUser; role: WorkspaceRole }>,
): Promise<string> {
  counter += 1;
  const workspace = await app.get(PrismaService).workspace.create({
    data: {
      id: newId(),
      name: `Workspace ${counter}`,
      slug: `ws-${counter}`,
      memberships: { create: members.map((m) => ({ userId: m.user.id, role: m.role })) },
    },
  });
  return workspace.id;
}

/** Signs in and returns the Cookie header value for the following requests. */
export async function login(app: NestFastifyApplication, user: TestUser): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: user.email, password: user.password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Login failed: ${response.statusCode} ${response.body}`);
  }
  const cookie = response.cookies.find((c) => c.name === 'sid');
  if (!cookie) {
    throw new Error('No session cookie');
  }
  return `sid=${cookie.value}`;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Short requests on behalf of the signed-in user: `const http = client(app, cookie); await http.get('/x')`. */
export function client(app: NestFastifyApplication, cookie: string) {
  const call = (method: Method, url: string, payload?: object) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });
  return {
    cookie,
    get: (url: string) => call('GET', url),
    post: (url: string, payload?: object) => call('POST', url, payload ?? {}),
    patch: (url: string, payload: object) => call('PATCH', url, payload),
    put: (url: string, payload: object) => call('PUT', url, payload),
    delete: (url: string) => call('DELETE', url),
  };
}

/** A user with a role in a new workspace and a signed-in client. */
export async function setupWorkspace(app: NestFastifyApplication, role: WorkspaceRole = 'admin') {
  const user = await createUser(app);
  const workspaceId = await createWorkspace(app, [{ user, role }]);
  const http = client(app, await login(app, user));
  return { user, workspaceId, http };
}

export interface TestApiChannel {
  id: string;
  apiKey: string;
  webhookSecret?: string;
}

export async function createApiChannel(
  http: ReturnType<typeof client>,
  workspaceId: string,
  options: { metadataMapping?: Record<string, string>; webhookUrl?: string } = {},
): Promise<TestApiChannel> {
  const response = await http.post(`/workspaces/${workspaceId}/channels`, { type: 'api', name: 'API', ...options });
  if (response.statusCode !== 201) {
    throw new Error(`Channel creation failed: ${response.body}`);
  }
  const body = response.json();
  return { id: body.channel.id, apiKey: body.apiKey, webhookSecret: body.webhookSecret };
}

let externalCounter = 0;

export function ingest(app: NestFastifyApplication, channel: TestApiChannel, body: Record<string, unknown> = {}) {
  externalCounter += 1;
  return app.inject({
    method: 'POST',
    url: `/api/v1/ingest/${channel.id}`,
    headers: { authorization: `Bearer ${channel.apiKey}` },
    payload: {
      external_id: `ext-${externalCounter}`,
      customer: { name: 'Иван', identities: { email: 'ivan@example.com' } },
      subject: 'Не начислили баллы',
      body: 'Купил кофе вчера, баллы не пришли',
      ...body,
    },
  });
}

export async function createMailbox(
  http: ReturnType<typeof client>,
  workspaceId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await http.post(`/workspaces/${workspaceId}/channels`, {
    type: 'email',
    name: 'Поддержка',
    address: 'support@example.com',
    displayName: 'Поддержка Example',
    signatureHtml: '<p>— Команда поддержки</p>',
    smtp: { host: 'smtp.example.com', port: 465, user: 'support@example.com', password: 'smtp-pass' },
    ...overrides,
  });
  if (response.statusCode !== 201) {
    throw new Error(`Mailbox creation failed: ${response.body}`);
  }
  return response.json().channel.id;
}
