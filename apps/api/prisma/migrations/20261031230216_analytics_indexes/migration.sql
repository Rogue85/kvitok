-- CreateIndex
CREATE INDEX "agent_runs_workspace_id_created_at_idx" ON "agent_runs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "tickets_workspace_id_created_at_idx" ON "tickets"("workspace_id", "created_at");
