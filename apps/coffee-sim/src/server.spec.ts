import { IntegrationClient, runConformance } from '@kvitok/protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { simConformanceProfile } from './profile.js';
import { createSimServer, type SimServer } from './server.js';

const SECRET = 'sim-test-secret';
let sim: SimServer;
let url: string;
let client: IntegrationClient;

beforeAll(async () => {
  sim = createSimServer({ secret: SECRET, prefix: '/api/support', faultTimeoutMs: 400, locale: 'ru' });
  url = await sim.listen();
  client = new IntegrationClient({ baseUrl: url, secret: SECRET, timeoutMs: 200 });
});

afterAll(() => sim.close());

beforeEach(() => sim.reset());

describe('coffee-sim over the protocol', () => {
  it('passes all protocol checks (with a path prefix)', async () => {
    const report = await runConformance(simConformanceProfile(sim.store, url, SECRET));
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(report.checks.filter((c) => c.status === 'pass').length).toBeGreaterThanOrEqual(25);
  });

  it('resolve: a phone in any format; email narrows matches; a shared email without a phone — ambiguous', async () => {
    expect(await client.resolve({ phone: '8 (900) 000-00-01' })).toMatchObject({ status: 'found', customer_ref: 'anna' });
    expect(await client.resolve({ email: 'ANNA@example.test', phone: '79999999999' })).toMatchObject({ status: 'found', customer_ref: 'anna' });
    sim.store.guests.get('boris')!.email = 'anna@example.test';
    expect(await client.resolve({ email: 'anna@example.test' })).toMatchObject({ status: 'ambiguous', candidates: [{ customer_ref: 'anna' }, { customer_ref: 'boris' }] });
    expect(await client.resolve({ email: 'anna@example.test', phone: '79000000002' })).toMatchObject({ status: 'found', customer_ref: 'boris' });
  });

  it('resolve: matched_by lists the matching identities; identities of different guests — ambiguous with their own matched_by', async () => {
    const anna = sim.store.guests.get('anna')!;
    const boris = sim.store.guests.get('boris')!;
    expect(await client.resolve({ phone: anna.phone, card_number: anna.cardNumber, email: 'nobody@example.test' })).toEqual({
      status: 'found',
      customer_ref: 'anna',
      display_name: anna.name,
      matched_by: ['phone', 'card_number'],
    });
    expect(await client.resolve({ phone: anna.phone, card_number: boris.cardNumber })).toMatchObject({
      status: 'ambiguous',
      candidates: [
        { customer_ref: 'anna', matched_by: ['phone'] },
        { customer_ref: 'boris', matched_by: ['card_number'] },
      ],
    });
  });

  it('the manifest describes identity patterns that find values in text', async () => {
    const { manifest } = (await client.manifest()) as { manifest: { identity_types: Array<{ type: string; pattern?: string }> } };
    const find = (type: string, text: string) => {
      const pattern = manifest.identity_types.find((i) => i.type === type)!.pattern!;
      return [...text.matchAll(new RegExp(pattern, 'gi'))].map((m) => m.groups?.value ?? m[0]);
    };
    expect(find('card_number', 'Карта 700012345, чек 1700012345 и телефон 79170012345')).toEqual(['700012345']);
    expect(find('phone', 'звоните +7 (912) 345-67-89 или 89123456789, заказ 5791234567890')).toEqual(['+7 (912) 345-67-89', '89123456789']);
  });

  it('another guest\'s receipt via a tool is indistinguishable from a nonexistent one', async () => {
    await expect(client.callTool('get_receipt', 'anna', { transaction_id: 'boris-t1' })).rejects.toMatchObject({ code: 'not_found', status: 404 });
    const own = await client.callTool('get_receipt', 'boris', { transaction_id: 'boris-t1' });
    expect(own.data).toMatchObject({ total: 640, balance_add: 0, cups: { drinks: 1, counted: 1 } });
  });

  it('execute: semantically invalid — failed without changes and still idempotent', async () => {
    const params = { basis: 'base_cashback', amount: 26, transaction_id: 'vera-t1' };
    const first = await client.execute('accrue_points', 'vera', params, 'k-vera');
    expect(first).toMatchObject({ status: 'failed', error: expect.stringMatching(/уже начислены/) });
    expect(await client.executionStatus('k-vera')).toMatchObject({ status: 'failed', action: 'accrue_points' });
    expect(sim.store.guests.get('vera')!.balance).toBe(126);
  });

  it('drop_response failure: the action is executed once, status by key — executed, a repeat returns the same response', async () => {
    sim.addFault('execute:accrue_points', 'drop_response');
    const params = { basis: 'writeoff_refund', amount: 120, transaction_id: 'gleb-t1' };

    await expect(client.execute('accrue_points', 'gleb', params, 'k-gleb')).rejects.toMatchObject({ retryable: true });
    const status = await client.executionStatus('k-gleb');
    const retry = await client.execute('accrue_points', 'gleb', params, 'k-gleb');

    expect(status).toMatchObject({ status: 'executed', external_ref: retry.external_ref });
    expect(sim.store.guests.get('gleb')!.balance).toBe(135);
    expect([...sim.store.executions.values()].filter((e) => e.customerRef === 'gleb')).toHaveLength(1);
  });

  it('error_500 failure — nothing executed, status unknown; timeout — the client times out but the action is executed', async () => {
    const params = { basis: 'drinks_not_counted', count: 2, transaction_id: 'zoya-t1' };
    sim.addFault('execute:*', 'error_500');
    await expect(client.execute('accrue_cups', 'zoya', params, 'k-zoya')).rejects.toMatchObject({ code: 'internal', retryable: true });
    expect(await client.executionStatus('k-zoya')).toEqual({ status: 'unknown' });

    sim.addFault('execute:accrue_cups', 'timeout');
    await expect(client.execute('accrue_cups', 'zoya', params, 'k-zoya')).rejects.toMatchObject({ code: 'timeout' });
    expect(await client.executionStatus('k-zoya')).toMatchObject({ status: 'executed' });
    expect(sim.store.activeCups('zoya')).toBe(4);
  });

  it('service /__sim: reset to one scenario, execution journal, guest state', async () => {
    await client.execute('accrue_cups', 'ivan', { basis: 'coupon_not_issued', count: 5 }, 'k-ivan');
    const base = url.replace(/\/api\/support$/, '');
    const executions = (await (await fetch(`${base}/api/support/__sim/executions`)).json()) as Array<{ key: string }>;
    expect(executions.map((e) => e.key)).toEqual(['k-ivan']);
    expect(await (await fetch(`${base}/api/support/__sim/guests/ivan`)).json()).toMatchObject({ active_cups: 5 });

    const reset = await fetch(`${base}/api/support/__sim/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenarios: ['app-login-code'] }) });
    expect(await reset.json()).toEqual({ ok: true, scenarios: ['app-login-code'] });
    expect(sim.store.guests.size).toBe(1);
    expect(sim.store.executions.size).toBe(0);
  });

  it('manifest: tools, actions, playbooks and departments from the content; JSON Schema of arguments', async () => {
    const result = await client.manifest();
    if (result.notModified) throw new Error('unexpected 304');
    const { manifest } = result;
    expect(manifest.tools.map((t) => t.name)).toContain('get_cups_progress');
    expect(manifest.tools.find((t) => t.name === 'get_promos')).toMatchObject({ requires_customer: false });
    expect(manifest.actions.find((a) => a.name === 'accrue_points')!.input_schema).toMatchObject({
      type: 'object',
      required: ['basis', 'amount'],
      properties: { basis: { enum: ['base_cashback', 'promo_cashback', 'writeoff_refund'] } },
    });
    expect(manifest.playbooks.map((p) => p.key)).toEqual(['cups_6th_free', 'pickup_order', 'points_not_accrued', 'points_writeoff_refund', 'promo_issues']);
    expect(manifest.suggested_departments.map((d) => d.key)).toEqual(['loyalty', 'app', 'stores']);
    expect(manifest.instructions).toContain('6-я кружка');
  });
});
