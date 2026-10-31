-- AlterTable
ALTER TABLE "playbooks" ADD COLUMN     "integration_id" TEXT;

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "secrets" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "manifest" JSONB,
    "manifest_etag" TEXT,
    "manifest_hash" TEXT,
    "synced_at" TIMESTAMPTZ,
    "last_sync_at" TIMESTAMPTZ,
    "last_sync_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integrations_workspace_id_idx" ON "integrations"("workspace_id");

-- CreateIndex
CREATE INDEX "playbooks_integration_id_idx" ON "playbooks"("integration_id");

-- AddForeignKey
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
