export const MAINTENANCE_QUEUE = 'maintenance';

export const MaintenanceJob = {
  cleanupSessions: 'cleanup-sessions',
  syncIntegrations: 'sync-integrations',
} as const;
