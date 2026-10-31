import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AuditLogDto } from '@kvitok/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetDb, setupWorkspace } from '../helpers';

describe('audit log', () => {
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

  it('records configuration changes with the user or the token that made them', async () => {
    const { http, workspaceId, user } = await setupWorkspace(app);
    const created = (await http.post(`/workspaces/${workspaceId}/departments`, { key: 'loyalty', title: 'Лояльность' })).json();
    const { secret } = (await http.post('/tokens', { name: 'Claude Code', scopes: ['read', 'config:write'] })).json();
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${workspaceId}/departments/${created.id}`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { description: 'Баллы и купоны' },
    });
    expect(patched.statusCode).toBe(200);

    const log: AuditLogDto[] = (await http.get(`/workspaces/${workspaceId}/audit`)).json();

    expect(log.map((e) => [e.entity, e.action])).toEqual([
      ['department', 'update'],
      ['department', 'create'],
    ]);
    expect(log[1]).toMatchObject({ entityId: created.id, actor: { type: 'user', userId: user.id, tokenName: null }, before: null });
    expect(log[0]).toMatchObject({
      actor: { type: 'token', userId: user.id, tokenName: 'Claude Code' },
      before: { description: '' },
      after: { description: 'Баллы и купоны' },
    });
  });

  it('does not record an update that changed nothing', async () => {
    const { http, workspaceId } = await setupWorkspace(app);
    const created = (await http.post(`/workspaces/${workspaceId}/departments`, { key: 'loyalty', title: 'Лояльность' })).json();

    await http.patch(`/workspaces/${workspaceId}/departments/${created.id}`, { title: 'Лояльность' });

    expect((await http.get(`/workspaces/${workspaceId}/audit`)).json()).toHaveLength(1);
  });

  it('never stores secrets, only the fact that one changed', async () => {
    const { http, workspaceId } = await setupWorkspace(app);
    const provider = (
      await http.post(`/workspaces/${workspaceId}/llm-providers`, { name: 'LLM', baseUrl: 'http://llm.test/v1', apiKey: 'sk-very-secret-key' })
    ).json();
    await http.patch(`/workspaces/${workspaceId}/llm-providers/${provider.id}`, { apiKey: 'sk-another-secret-key' });
    const channel = (await http.post(`/workspaces/${workspaceId}/channels`, { type: 'api', name: 'App', webhookUrl: 'http://app.test/hook' })).json();
    await http.post(`/workspaces/${workspaceId}/channels/${channel.channel.id}/rotate-key`);

    const response = await http.get(`/workspaces/${workspaceId}/audit`);
    const log: AuditLogDto[] = response.json();

    expect(response.body).not.toContain('sk-very-secret-key');
    expect(response.body).not.toContain('sk-another-secret-key');
    expect(response.body).not.toContain(channel.apiKey);
    expect(response.body).not.toContain(channel.webhookSecret);
    expect(log.find((e) => e.entity === 'llm_provider' && e.action === 'update')?.after).toMatchObject({ apiKeyChanged: true, hasApiKey: true });
    expect(log.map((e) => e.action)).toContain('rotate_key');
  });

  it('filters by entity and pages by time; only admins read it', async () => {
    const { http, workspaceId } = await setupWorkspace(app);
    for (const key of ['a', 'b', 'c']) {
      await http.post(`/workspaces/${workspaceId}/departments`, { key, title: key.toUpperCase() });
    }
    await http.patch(`/workspaces/${workspaceId}`, { name: 'Coffee' });

    const departments: AuditLogDto[] = (await http.get(`/workspaces/${workspaceId}/audit?entity=department&limit=2`)).json();
    const next: AuditLogDto[] = (
      await http.get(`/workspaces/${workspaceId}/audit?entity=department&limit=2&cursor=${departments[1]!.id}`)
    ).json();

    expect(departments.map((e) => e.after?.key)).toEqual(['c', 'b']);
    expect(next.map((e) => e.after?.key)).toEqual(['a']);

    const operator = await setupWorkspace(app, 'operator');
    expect((await operator.http.get(`/workspaces/${operator.workspaceId}/audit`)).statusCode).toBe(403);
  });
});
