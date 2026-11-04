import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSimServer, type SimServer } from '@kvitok/coffee-sim';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature, type ManifestInput } from '@kvitok/protocol';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSnapshotService } from '../../src/agent/config-snapshot.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createApiChannel, createTestApp, ingest, resetDb, setupWorkspace } from '../helpers';

const SIM_SECRET = 'coffee-sim-test-secret';
const BACKEND_SECRET = 'backend-test-secret-0001';

/** A backend with a changeable manifest and option sets: checks the signature, returns ETag and 304. */
function manifestBackend() {
  let manifest: ManifestInput = { protocol_version: 1, name: 'shop', title: 'Магазин', playbooks: [] };
  let version = 1;
  const sets = new Map<string, { options: unknown[]; version: number } | 'fail'>();
  const server: Server = createServer((req, res) => {
    const verified = verifySignature({
      secret: BACKEND_SECRET,
      method: req.method!,
      path: req.url!,
      body: '',
      timestamp: req.headers[TIMESTAMP_HEADER],
      signature: req.headers[SIGNATURE_HEADER],
    });
    if (!verified.ok) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'invalid_signature', message: verified.reason } }));
      return;
    }
    const setName = /^\/option-sets\/([a-z_]+)$/.exec(req.url!)?.[1];
    if (setName !== undefined) {
      const set = sets.get(setName);
      if (set === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'internal', message: 'db down' } }));
        return;
      }
      if (!set) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'unknown_option_set', message: setName } }));
        return;
      }
      const setEtag = `"${setName}-${set.version}"`;
      if (req.headers['if-none-match'] === setEtag) {
        res.writeHead(304, { etag: setEtag }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', etag: setEtag }).end(JSON.stringify({ options: set.options }));
      return;
    }
    const etag = `"v${version}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', etag }).end(JSON.stringify(manifest));
  });
  return {
    server,
    set(next: ManifestInput) {
      manifest = next;
      version += 1;
    },
    setOptions(name: string, options: unknown[] | 'fail') {
      const previous = sets.get(name);
      sets.set(name, options === 'fail' ? 'fail' : { options, version: (previous && previous !== 'fail' ? previous.version : 0) + 1 });
    },
  };
}

const playbook = (key: string, body = 'Шаги разбора') => ({ key, title: `Плейбук ${key}`, when: `Когда ${key}`, body });

describe('integrations', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let sim: SimServer;
  let simUrl: string;
  let backend: ReturnType<typeof manifestBackend>;
  let backendUrl: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    sim = createSimServer({ secret: SIM_SECRET, prefix: '/api/support', locale: 'ru' });
    simUrl = await sim.listen();
    backend = manifestBackend();
    await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
    backendUrl = `http://127.0.0.1:${(backend.server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  afterAll(async () => {
    await sim.close();
    backend.server.closeAllConnections();
    await new Promise((resolve) => backend.server.close(resolve));
    await app.close();
  });

  it('creation fetches the manifest right away: tools and actions with parameters, playbooks, suggested departments; the secret is not returned', async () => {
    const { workspaceId, http } = await setupWorkspace(app);

    const response = await http.post(`/workspaces/${workspaceId}/integrations`, { name: 'Кофейня', baseUrl: simUrl, secret: SIM_SECRET });

    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain(SIM_SECRET);
    const { integration, sync } = response.json();
    expect(sync).toMatchObject({ status: 'updated', playbooks: { removed: [], skipped: [] } });
    expect(sync.playbooks.added.sort()).toEqual(['cups_6th_free', 'pickup_order', 'points_not_accrued', 'points_writeoff_refund', 'promo_issues']);
    expect(integration).toMatchObject({ name: 'Кофейня', hasSecret: true, lastSyncError: null, manifest: { name: 'coffee_sim', protocolVersion: 1 } });
    expect(integration.manifestEtag).toMatch(/^"/);
    expect(integration.manifest.tools.find((t: { name: string }) => t.name === 'get_transactions')).toMatchObject({
      requiresCustomer: true,
      display: 'table',
      params: expect.arrayContaining([{ name: 'limit', type: 'integer', required: false, description: null }]),
    });
    expect(integration.manifest.actions.find((a: { name: string }) => a.name === 'accrue_points').params[0]).toMatchObject({
      name: 'basis',
      type: 'base_cashback | promo_cashback | writeoff_refund',
      required: true,
    });
    expect(integration.manifest.suggestedDepartments.map((d: { key: string; exists: boolean }) => [d.key, d.exists])).toEqual([
      ['loyalty', false],
      ['app', false],
      ['stores', false],
    ]);

    const playbooks = (await http.get(`/workspaces/${workspaceId}/playbooks`)).json();
    expect(playbooks).toHaveLength(5);
    expect(playbooks.every((p: { source: string; integrationId: string }) => p.source === 'manifest' && p.integrationId === integration.id)).toBe(true);
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } });
    expect(row.secrets).not.toContain(SIM_SECRET);
  });

  it('a repeated sync — 304; force — a full one without changes; a wrong secret — an error in the status, the manifest stays', async () => {
    const { workspaceId, http } = await setupWorkspace(app);
    const { integration } = (await http.post(`/workspaces/${workspaceId}/integrations`, { name: 'Кофейня', baseUrl: simUrl, secret: SIM_SECRET })).json();
    const url = `/workspaces/${workspaceId}/integrations/${integration.id}`;

    const unchanged = { name: 'places', status: 'not_modified', added: 0, changed: 0, archived: 0, restored: 0 };
    expect((await http.post(`${url}/sync`)).json().sync).toEqual({ status: 'not_modified', optionSets: [unchanged] });
    expect((await http.post(`${url}/sync`, { force: true })).json().sync).toEqual({
      status: 'updated',
      playbooks: { added: [], updated: [], removed: [], skipped: [] },
      optionSets: [unchanged],
    });

    await http.patch(url, { secret: 'wrong-secret-wrong-secret' });
    const failed = (await http.post(`${url}/sync`)).json();
    expect(failed.sync).toMatchObject({ status: 'error', error: expect.stringMatching(/^invalid_signature/) });
    expect(failed.integration).toMatchObject({ lastSyncError: expect.stringMatching(/^invalid_signature/), manifest: { name: 'coffee_sim' } });

    const offline = (await http.post(`/workspaces/${workspaceId}/integrations`, { name: 'Нет связи', baseUrl: 'http://127.0.0.1:1', secret: SIM_SECRET })).json();
    expect(offline.sync).toMatchObject({ status: 'error', error: expect.stringMatching(/^network/) });
    expect(offline.integration).toMatchObject({ manifest: null, syncedAt: null });
  });

  it('importing departments: only selected and missing ones are created; playbooks get linked to departments', async () => {
    const { workspaceId, http } = await setupWorkspace(app);
    const stores = (await http.post(`/workspaces/${workspaceId}/departments`, { key: 'stores', title: 'Кофейни (наш)' })).json();
    const { integration } = (await http.post(`/workspaces/${workspaceId}/integrations`, { name: 'Кофейня', baseUrl: simUrl, secret: SIM_SECRET })).json();

    const imported = await http.post(`/workspaces/${workspaceId}/integrations/${integration.id}/import-departments`, { keys: ['loyalty', 'stores'] });

    expect(imported.statusCode).toBe(201);
    expect(imported.json().map((d: { key: string }) => d.key)).toEqual(['loyalty']);
    const departments = (await http.get(`/workspaces/${workspaceId}/departments`)).json();
    expect(departments.find((d: { key: string }) => d.key === 'stores').title).toBe('Кофейни (наш)');
    const loyalty = departments.find((d: { key: string }) => d.key === 'loyalty');
    expect(loyalty.description).toMatch(/Баллы и кэшбек/);
    const playbooks = await prisma.playbook.findMany({ where: { workspaceId } });
    expect(playbooks.find((p) => p.key === 'points_not_accrued')!.departmentId).toBe(loyalty.id);
    expect(playbooks.find((p) => p.key === 'pickup_order')!.departmentId).toBe(stores.id);
    const listed = (await http.get(`/workspaces/${workspaceId}/integrations`)).json();
    expect(listed[0].manifest.suggestedDepartments.filter((d: { exists: boolean }) => d.exists).map((d: { key: string }) => d.key)).toEqual(['loyalty', 'stores']);
  });

  it('a playbook from a manifest: can only be disabled; a disabled one stays disabled; changes and deletions come from the manifest; a key from the interface is not overwritten', async () => {
    const { workspaceId, http } = await setupWorkspace(app);
    await http.post(`/workspaces/${workspaceId}/playbooks`, { key: 'refunds', title: 'Возвраты (наш)', when: 'возврат', body: 'Наш текст' });
    backend.set({ protocol_version: 1, name: 'shop', title: 'Магазин', playbooks: [playbook('delivery'), playbook('payments'), playbook('refunds')] });

    const created = (await http.post(`/workspaces/${workspaceId}/integrations`, { name: 'Магазин', baseUrl: backendUrl, secret: BACKEND_SECRET })).json();
    expect(created.sync.playbooks).toMatchObject({ added: ['delivery', 'payments'], skipped: [{ key: 'refunds', reason: 'the key is taken by a playbook created in the interface' }] });

    const delivery = (await prisma.playbook.findFirstOrThrow({ where: { workspaceId, key: 'delivery' } })).id;
    expect((await http.patch(`/workspaces/${workspaceId}/playbooks/${delivery}`, { enabled: false })).statusCode).toBe(200);
    expect((await http.patch(`/workspaces/${workspaceId}/playbooks/${delivery}`, { title: 'Своё' })).statusCode).toBe(409);
    expect((await http.delete(`/workspaces/${workspaceId}/playbooks/${delivery}`)).statusCode).toBe(409);

    backend.set({ protocol_version: 1, name: 'shop', title: 'Магазин', playbooks: [playbook('delivery', 'Новые шаги'), playbook('refunds')] });
    const synced = (await http.post(`/workspaces/${workspaceId}/integrations/${created.integration.id}/sync`)).json();

    expect(synced.sync.playbooks).toMatchObject({ added: [], updated: ['delivery'], removed: ['payments'] });
    expect(await prisma.playbook.findUniqueOrThrow({ where: { id: delivery } })).toMatchObject({ body: 'Новые шаги', enabled: false, version: 2 });
    expect(await prisma.playbook.findFirstOrThrow({ where: { workspaceId, key: 'refunds' } })).toMatchObject({ source: 'ui', body: 'Наш текст' });

    await http.delete(`/workspaces/${workspaceId}/integrations/${created.integration.id}`);
    expect((await prisma.playbook.findMany({ where: { workspaceId } })).map((p) => p.key)).toEqual(['refunds']);
  });

  it('the agent gets the integration knowledge and its playbooks; disabling the integration removes them and changes the configuration version', async () => {
    const { workspaceId, http } = await setupWorkspace(app);
    const snapshots = app.get(ConfigSnapshotService);
    const before = await snapshots.resolve(workspaceId);
    const { integration } = (await http.post(`/workspaces/${workspaceId}/integrations`, { name: 'Кофейня', baseUrl: simUrl, secret: SIM_SECRET })).json();

    const withIntegration = await snapshots.resolve(workspaceId);
    expect(withIntegration.version.number).toBe(before.version.number + 1);
    expect(withIntegration.snapshot.integrations).toEqual([
      { id: integration.id, name: 'coffee_sim', title: 'Сеть кофеен (симулятор)', instructions: expect.stringContaining('6-я кружка'), manifestHash: expect.any(String) },
    ]);
    expect(withIntegration.snapshot.playbooks).toHaveLength(5);

    await http.patch(`/workspaces/${workspaceId}/integrations/${integration.id}`, { enabled: false });
    const disabled = await snapshots.resolve(workspaceId);
    expect(disabled.snapshot.integrations).toEqual([]);
    expect(disabled.snapshot.playbooks).toEqual([]);
    expect(disabled.version.hash).toBe(before.version.hash);
  });

  it('option sets: synced with the manifest, a field takes their options; missing options are archived, an error keeps the list, removal freezes the options', async () => {
    const { workspaceId, http } = await setupWorkspace(app);
    backend.set({ protocol_version: 1, name: 'shop', title: 'Магазин', option_sets: [{ name: 'places', title: 'Кофейни', description: 'value — place_id' }] });
    backend.setOptions('places', [
      { value: '512', label: 'Тверская, 12', group: 'Москва', description: 'м. Пушкинская' },
      { value: '513', label: 'ТЦ «Кристалл»', group: 'Москва' },
      { value: '600', label: 'ТЦ «Тиара»', group: 'Казань', active: false },
    ]);
    const created = (await http.post(`/workspaces/${workspaceId}/integrations`, { name: 'Магазин', baseUrl: backendUrl, secret: BACKEND_SECRET })).json();
    expect(created.sync.optionSets).toEqual([{ name: 'places', status: 'updated', added: 3, changed: 0, archived: 0, restored: 0 }]);
    const [set] = created.integration.optionSets;
    expect(set).toMatchObject({ name: 'places', title: 'Кофейни', integrationName: 'Магазин', size: 3, activeSize: 2, removed: false, lastSyncError: null, fieldKeys: [] });

    // A bound field takes the set's options; its own list is not accepted, only lists can be bound.
    expect((await http.post(`/workspaces/${workspaceId}/fields`, { entity: 'ticket', key: 'note', label: 'Заметка', type: 'text', optionSetId: set.id })).statusCode).toBe(422);
    const field = (await http.post(`/workspaces/${workspaceId}/fields`, { entity: 'ticket', key: 'coffee_shop', label: 'Кофейня', type: 'select', optionSetId: set.id, fillMode: 'agent_suggest' })).json();
    expect(field).toMatchObject({ optionSet: { id: set.id, name: 'places', removed: false }, agentOptionsMode: 'auto' });
    expect(field.options).toEqual([
      { value: '512', label: 'Тверская, 12', group: 'Москва', agentHint: 'м. Пушкинская' },
      { value: '513', label: 'ТЦ «Кристалл»', group: 'Москва' },
      { value: '600', label: 'ТЦ «Тиара»', group: 'Казань', archived: true },
    ]);

    // An archived option cannot be chosen; an active one can.
    const channel = await createApiChannel(http, workspaceId);
    const ticketId = (await ingest(app, channel, { body: 'Горький кофе' })).json().ticket_id;
    expect((await http.patch(`/workspaces/${workspaceId}/tickets/${ticketId}`, { fields: { coffee_shop: '600' } })).statusCode).toBe(422);
    expect((await http.patch(`/workspaces/${workspaceId}/tickets/${ticketId}`, { fields: { coffee_shop: '513' } })).statusCode).toBe(200);

    // The backend drops 513 and renames 512: 513 is archived, the ticket keeps it and stays editable.
    backend.setOptions('places', [{ value: '512', label: 'Тверская ул., 12', group: 'Москва' }, { value: '600', label: 'ТЦ «Тиара»', group: 'Казань' }]);
    const resynced = (await http.post(`/workspaces/${workspaceId}/integrations/${created.integration.id}/sync`)).json();
    expect(resynced.sync.optionSets).toEqual([{ name: 'places', status: 'updated', added: 0, changed: 1, archived: 1, restored: 1 }]);
    const fields = (await http.get(`/workspaces/${workspaceId}/fields?entity=ticket`)).json();
    expect(fields.find((f: { key: string }) => f.key === 'coffee_shop').options.map((o: { value: string; archived?: boolean }) => [o.value, o.archived ?? false])).toEqual([
      ['512', false],
      ['600', false],
      ['513', true],
    ]);
    expect((await http.patch(`/workspaces/${workspaceId}/tickets/${ticketId}`, { tags: ['x'], fields: { coffee_shop: '513' } })).statusCode).toBe(200);

    // A failed sync keeps the options and shows the error.
    backend.setOptions('places', 'fail');
    const failed = (await http.post(`/workspaces/${workspaceId}/integrations/${created.integration.id}/sync`, { force: true })).json();
    expect(failed.sync.optionSets[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/^internal/) });
    expect(failed.integration.optionSets[0]).toMatchObject({ size: 3, lastSyncError: expect.stringMatching(/^internal/), fieldKeys: ['coffee_shop'] });

    // The manifest drops the set: the field keeps its options, the set is marked removed.
    backend.set({ protocol_version: 1, name: 'shop', title: 'Магазин' });
    const dropped = (await http.post(`/workspaces/${workspaceId}/integrations/${created.integration.id}/sync`)).json();
    expect(dropped.integration.optionSets[0]).toMatchObject({ removed: true, size: 3 });

    // Removing the integration freezes the options into the field.
    expect((await http.delete(`/workspaces/${workspaceId}/integrations/${created.integration.id}`)).statusCode).toBe(204);
    const frozen = (await http.get(`/workspaces/${workspaceId}/fields?entity=ticket`)).json().find((f: { key: string }) => f.key === 'coffee_shop');
    expect(frozen).toMatchObject({ optionSet: null });
    expect(frozen.options.map((o: { value: string }) => o.value)).toEqual(['512', '600', '513']);
    expect((await http.patch(`/workspaces/${workspaceId}/tickets/${ticketId}`, { fields: { coffee_shop: '512' } })).statusCode).toBe(200);
  });

  it('an operator sees integrations but does not change them', async () => {
    const { workspaceId, http } = await setupWorkspace(app, 'operator');
    expect((await http.get(`/workspaces/${workspaceId}/integrations`)).statusCode).toBe(200);
    expect((await http.post(`/workspaces/${workspaceId}/integrations`, { name: 'Кофейня', baseUrl: simUrl, secret: SIM_SECRET })).statusCode).toBe(403);
  });
});
