-- CreateTable
CREATE TABLE "customer_links" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "customer_ref" TEXT,
    "display_name" TEXT,
    "candidates" JSONB NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'auto',
    "identities_hash" TEXT,
    "last_error" TEXT,
    "resolved_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "customer_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_links_integration_id_idx" ON "customer_links"("integration_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_links_customer_id_integration_id_key" ON "customer_links"("customer_id", "integration_id");

-- AddForeignKey
ALTER TABLE "customer_links" ADD CONSTRAINT "customer_links_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_links" ADD CONSTRAINT "customer_links_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
