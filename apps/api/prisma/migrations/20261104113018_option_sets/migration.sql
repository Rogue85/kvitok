-- CreateEnum
CREATE TYPE "FieldAgentOptionsMode" AS ENUM ('auto', 'list', 'search');

-- AlterTable
ALTER TABLE "field_definitions" ADD COLUMN     "agent_options_mode" "FieldAgentOptionsMode" NOT NULL DEFAULT 'auto',
ADD COLUMN     "option_set_id" TEXT;

-- CreateTable
CREATE TABLE "option_sets" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "options" JSONB NOT NULL DEFAULT '[]',
    "etag" TEXT,
    "hash" TEXT NOT NULL DEFAULT '',
    "synced_at" TIMESTAMPTZ,
    "last_sync_error" TEXT,
    "removed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "option_sets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "option_sets_workspace_id_idx" ON "option_sets"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "option_sets_integration_id_name_key" ON "option_sets"("integration_id", "name");

-- CreateIndex
CREATE INDEX "field_definitions_option_set_id_idx" ON "field_definitions"("option_set_id");

-- AddForeignKey
ALTER TABLE "field_definitions" ADD CONSTRAINT "field_definitions_option_set_id_fkey" FOREIGN KEY ("option_set_id") REFERENCES "option_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_sets" ADD CONSTRAINT "option_sets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_sets" ADD CONSTRAINT "option_sets_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
