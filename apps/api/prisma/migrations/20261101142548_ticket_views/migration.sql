-- CreateTable
CREATE TABLE "ticket_views" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "query" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ticket_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ticket_views_workspace_id_user_id_idx" ON "ticket_views"("workspace_id", "user_id");

-- AddForeignKey
ALTER TABLE "ticket_views" ADD CONSTRAINT "ticket_views_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_views" ADD CONSTRAINT "ticket_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
