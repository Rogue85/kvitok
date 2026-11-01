import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentSettingsService } from '../../src/agent/agent-settings.service';
import { SecretBox } from '../../src/crypto/secret-box';
import { PrismaService } from '../../src/prisma/prisma.service';
import { client, createTestApp, createUser, login, resetDb, setupWorkspace } from '../helpers';

describe('workspace settings', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('the agent settings of a new workspace survive parallel first reads', async () => {
    const { workspaceId } = await setupWorkspace(app);
    const settings = app.get(AgentSettingsService);

    const rows = await Promise.all(Array.from({ length: 5 }, () => settings.get(workspaceId)));

    expect(new Set(rows.map((r) => r.workspaceId))).toEqual(new Set([workspaceId]));
  });

  describe('fields', () => {
    it('creates a field, rejects a duplicate key and does not change key/type', async () => {
      const { workspaceId, http } = await setupWorkspace(app);
      const url = `/workspaces/${workspaceId}/fields`;

      const created = await http.post(url, {
        entity: 'ticket',
        key: 'dept_number',
        label: 'Номер отдела',
        type: 'number',
        validation: { integer: true },
        agentHint: 'Трёхзначный номер отдела из подписи',
        fillMode: 'agent_auto',
        display: ['sidebar', 'list_column'],
      });
      const duplicate = await http.post(url, { entity: 'ticket', key: 'dept_number', label: 'X', type: 'text' });
      const updated = await http.patch(`${url}/${created.json().id}`, { label: 'Отдел', key: 'other', type: 'text' });

      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ key: 'dept_number', fillMode: 'agent_auto', archived: false });
      expect(duplicate.statusCode).toBe(409);
      expect(updated.json()).toMatchObject({ label: 'Отдел', key: 'dept_number', type: 'number' });
    });

    it('archives a field and filters the list by entity', async () => {
      const { workspaceId, http } = await setupWorkspace(app);
      const url = `/workspaces/${workspaceId}/fields`;
      const field = await http.post(url, { entity: 'customer', key: 'employee_id', label: 'Табельный', type: 'text' });
      await http.post(url, { entity: 'ticket', key: 'note', label: 'Заметка', type: 'textarea' });

      const archived = await http.patch(`${url}/${field.json().id}`, { archived: true });
      const customerFields = await http.get(`${url}?entity=customer`);

      expect(archived.json().archived).toBe(true);
      expect(customerFields.json().map((f: { key: string }) => f.key)).toEqual(['employee_id']);
      expect((await http.get(url)).json()).toHaveLength(2);
    });

    it('a list without options — 422; an operator cannot create fields', async () => {
      const { workspaceId, http } = await setupWorkspace(app, 'operator');

      const denied = await http.post(`/workspaces/${workspaceId}/fields`, { entity: 'ticket', key: 'x', label: 'X', type: 'text' });

      expect(denied.statusCode).toBe(403);
      const admin = await setupWorkspace(app);
      const invalid = await admin.http.post(`/workspaces/${admin.workspaceId}/fields`, {
        entity: 'ticket',
        key: 'kind',
        label: 'Тип',
        type: 'select',
      });
      expect(invalid.statusCode).toBe(422);
    });
  });

  describe('departments', () => {
    it('creates departments; there can be only one triage department', async () => {
      const { workspaceId, http } = await setupWorkspace(app);
      const url = `/workspaces/${workspaceId}/departments`;

      const first = await http.post(url, { key: 'general', title: 'Общая очередь', isTriage: true });
      const second = await http.post(url, {
        key: 'it',
        title: 'ИТ',
        description: 'Компьютеры, принтеры, доступы',
        examples: ['Не печатает принтер на 3 этаже'],
        isTriage: true,
      });
      const list = await http.get(url);

      expect(first.statusCode).toBe(201);
      expect(second.json()).toMatchObject({ key: 'it', examples: ['Не печатает принтер на 3 этаже'] });
      expect(list.json().filter((d: { isTriage: boolean }) => d.isTriage).map((d: { key: string }) => d.key)).toEqual(['it']);
    });

    it('a partial update changes only the passed fields', async () => {
      const { workspaceId, http } = await setupWorkspace(app);
      const created = (
        await http.post(`/workspaces/${workspaceId}/departments`, { key: 'it', title: 'ИТ', description: 'Принтеры', examples: ['Не печатает'], isTriage: true })
      ).json();

      const renamed = await http.patch(`/workspaces/${workspaceId}/departments/${created.id}`, { title: 'Техподдержка' });

      expect(renamed.json()).toMatchObject({ title: 'Техподдержка', description: 'Принтеры', examples: ['Не печатает'], isTriage: true });
    });
  });

  describe('channels', () => {
    it('API channel: the key is shown once, the database stores only the hash', async () => {
      const { workspaceId, http } = await setupWorkspace(app);
      const prisma = app.get(PrismaService);

      const created = await http.post(`/workspaces/${workspaceId}/channels`, {
        type: 'api',
        name: 'Форма в приложении',
        metadataMapping: { category: 'category' },
        webhookUrl: 'https://example.com/hook',
      });
      const body = created.json();
      const list = await http.get(`/workspaces/${workspaceId}/channels`);
      const row = await prisma.channel.findUniqueOrThrow({ where: { id: body.channel.id } });

      expect(created.statusCode).toBe(201);
      expect(body.apiKey).toMatch(/^ask_/);
      expect(body.webhookSecret).toMatch(/^whsec_/);
      expect(JSON.stringify(list.json())).not.toContain(body.apiKey);
      expect(list.json()[0]).toMatchObject({ apiKeyPrefix: body.apiKey.slice(0, 10), hasWebhookSecret: true });
      expect(row.apiKeyHash).not.toContain(body.apiKey);
      expect(row.secrets).not.toContain(body.webhookSecret);
    });

    it('key rotation invalidates the old one', async () => {
      const { workspaceId, http } = await setupWorkspace(app);
      const created = (await http.post(`/workspaces/${workspaceId}/channels`, { type: 'api', name: 'API' })).json();

      const rotated = (await http.post(`/workspaces/${workspaceId}/channels/${created.channel.id}/rotate-key`)).json();

      expect(rotated.apiKey).not.toBe(created.apiKey);
    });

    it('mailbox: passwords are not returned, an update without a password keeps them; the first mailbox is the default', async () => {
      const { workspaceId, http } = await setupWorkspace(app);
      const prisma = app.get(PrismaService);
      const url = `/workspaces/${workspaceId}/channels`;

      const created = await http.post(url, {
        type: 'email',
        name: 'Поддержка',
        address: 'Support@Example.com',
        displayName: 'Поддержка Example',
        smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'support@example.com', password: 'smtp-pass' },
        imap: { host: 'imap.example.com', port: 993, user: 'support@example.com', password: 'imap-pass' },
      });
      const id = created.json().channel.id;
      const updated = await http.patch(`${url}/${id}`, {
        smtp: { host: 'smtp2.example.com', port: 587, secure: false, user: 'support@example.com' },
      });
      const row = await prisma.channel.findUniqueOrThrow({ where: { id } });

      expect(created.statusCode).toBe(201);
      expect(JSON.stringify(created.json())).not.toContain('smtp-pass');
      expect(created.json().channel).toMatchObject({
        address: 'support@example.com',
        isDefaultMailbox: true,
        smtp: { hasPassword: true },
        imap: { folder: 'INBOX', hasPassword: true, importExisting: false },
      });
      expect(updated.json().channel.smtp).toMatchObject({ host: 'smtp2.example.com', hasPassword: true });
      expect(new SecretBox(process.env.APP_SECRET!).decrypt(row.secrets!)).toEqual({
        smtpPassword: 'smtp-pass',
        imapPassword: 'imap-pass',
      });
    });

    it('a mailbox is not created without an SMTP password; a viewer does not manage channels', async () => {
      const { workspaceId, http } = await setupWorkspace(app);
      const viewer = await createUser(app);
      await http.post(`/workspaces/${workspaceId}/members`, { userId: viewer.id, role: 'viewer' });

      const noPassword = await http.post(`/workspaces/${workspaceId}/channels`, {
        type: 'email',
        name: 'Mail',
        address: 'a@example.com',
        smtp: { host: 'smtp.example.com', port: 465, user: 'a@example.com' },
      });
      const viewerHttp = client(app, await login(app, viewer));
      const denied = await viewerHttp.post(`/workspaces/${workspaceId}/channels`, { type: 'api', name: 'X' });
      const viewerList = await viewerHttp.get(`/workspaces/${workspaceId}/channels`);

      expect(noPassword.statusCode).toBe(422);
      expect(denied.statusCode).toBe(403);
      expect(viewerList.statusCode).toBe(200);
    });
  });
});
