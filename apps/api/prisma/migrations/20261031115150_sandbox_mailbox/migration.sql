-- CreateTable
CREATE TABLE "sandbox_emails" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "delivery_id" TEXT,
    "ticket_id" TEXT,
    "from_address" TEXT NOT NULL,
    "from_name" TEXT,
    "to" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT NOT NULL,
    "rfc_message_id" TEXT,
    "in_reply_to" TEXT,
    "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "html" TEXT,
    "text" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "headers" JSONB NOT NULL DEFAULT '[]',
    "raw" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_emails_delivery_id_key" ON "sandbox_emails"("delivery_id");

-- CreateIndex
CREATE INDEX "sandbox_emails_channel_id_created_at_idx" ON "sandbox_emails"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "sandbox_emails_ticket_id_idx" ON "sandbox_emails"("ticket_id");

-- AddForeignKey
ALTER TABLE "sandbox_emails" ADD CONSTRAINT "sandbox_emails_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_emails" ADD CONSTRAINT "sandbox_emails_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_emails" ADD CONSTRAINT "sandbox_emails_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
