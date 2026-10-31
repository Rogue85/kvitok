-- CreateTable
CREATE TABLE "action_proposals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "run_id" TEXT,
    "integration_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "customer_ref" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "normalized_params" JSONB,
    "preview" TEXT,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT NOT NULL,
    "calculation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ,
    "decision_comment" TEXT,
    "idempotency_key" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "executed_at" TIMESTAMPTZ,
    "result" JSONB,
    "external_ref" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "action_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "action_proposals_idempotency_key_key" ON "action_proposals"("idempotency_key");

-- CreateIndex
CREATE INDEX "action_proposals_ticket_id_created_at_idx" ON "action_proposals"("ticket_id", "created_at");

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
