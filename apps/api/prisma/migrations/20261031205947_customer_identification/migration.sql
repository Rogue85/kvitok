-- AlterTable
ALTER TABLE "customer_links" ADD COLUMN     "confirmed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "matched_by" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pending" JSONB;

-- AlterTable
ALTER TABLE "integrations" ADD COLUMN     "claim_linking" TEXT NOT NULL DEFAULT 'suggest',
ADD COLUMN     "field_mapping" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "text_identities" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "identification_rules" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "conditions" JSONB NOT NULL,
    "customer_from" TEXT NOT NULL DEFAULT 'sender',
    "extract" JSONB NOT NULL DEFAULT '[]',
    "stop" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "identification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_claims" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "message_id" TEXT,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "trust" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rule_id" TEXT,
    "rule_name" TEXT,
    "integration_id" TEXT,
    "run_id" TEXT,
    "evidence" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "identity_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "identification_rules_workspace_id_position_idx" ON "identification_rules"("workspace_id", "position");

-- CreateIndex
CREATE INDEX "identity_claims_workspace_id_type_value_idx" ON "identity_claims"("workspace_id", "type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "identity_claims_ticket_id_type_value_key" ON "identity_claims"("ticket_id", "type", "value");

-- AddForeignKey
ALTER TABLE "identification_rules" ADD CONSTRAINT "identification_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_claims" ADD CONSTRAINT "identity_claims_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_claims" ADD CONSTRAINT "identity_claims_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_claims" ADD CONSTRAINT "identity_claims_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
