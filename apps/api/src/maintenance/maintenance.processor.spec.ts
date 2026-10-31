import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { SessionCleanupService } from '../auth/session-cleanup.service';
import type { IntegrationsService } from '../integrations/integrations.service';
import { MaintenanceJob } from './maintenance.constants';
import { MaintenanceProcessor } from './maintenance.processor';

describe('MaintenanceProcessor', () => {
  const sessions = { deleteExpired: vi.fn().mockResolvedValue(3) } as unknown as SessionCleanupService;
  const integrations = { syncAll: vi.fn().mockResolvedValue(undefined) } as unknown as IntegrationsService;
  const processor = new MaintenanceProcessor(sessions, integrations);

  it('cleans up expired sessions', async () => {
    await expect(processor.process({ name: MaintenanceJob.cleanupSessions } as Job)).resolves.toEqual({ deleted: 3 });
    expect(sessions.deleteExpired).toHaveBeenCalledOnce();
  });

  it('syncs integrations', async () => {
    await expect(processor.process({ name: MaintenanceJob.syncIntegrations } as Job)).resolves.toEqual({ ok: true });
    expect(integrations.syncAll).toHaveBeenCalledOnce();
  });

  it('fails on an unknown job', async () => {
    await expect(processor.process({ name: 'unknown' } as Job)).rejects.toThrow(/Unknown maintenance job/);
  });
});
