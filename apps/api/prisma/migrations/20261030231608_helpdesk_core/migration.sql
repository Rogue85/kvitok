-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('api', 'email');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('new', 'open', 'pending', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "AgentState" AS ENUM ('idle', 'queued', 'running', 'failed');

-- CreateEnum
CREATE TYPE "MessageAuthorType" AS ENUM ('customer', 'operator', 'agent', 'system');

-- CreateEnum
CREATE TYPE "MessageVisibility" AS ENUM ('public', 'internal');

-- CreateEnum
CREATE TYPE "MessageSource" AS ENUM ('email', 'api', 'ui');

-- CreateEnum
CREATE TYPE "DeliveryKind" AS ENUM ('email', 'webhook');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('queued', 'sending', 'sent', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('customer', 'cc');

-- CreateEnum
CREATE TYPE "FieldEntity" AS ENUM ('ticket', 'customer');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('text', 'textarea', 'number', 'boolean', 'date', 'datetime', 'select', 'multiselect', 'email', 'phone', 'url');

-- CreateEnum
CREATE TYPE "FieldFillMode" AS ENUM ('manual', 'agent_suggest', 'agent_auto');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "default_mailbox_id" TEXT,
ADD COLUMN     "ticket_seq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "examples" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "instructions" TEXT NOT NULL DEFAULT '',
    "is_triage" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "type" "ChannelType" NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets" TEXT,
    "api_key_hash" TEXT,
    "api_key_prefix" TEXT,
    "sync_state" JSONB NOT NULL DEFAULT '{}',
    "last_sync_at" TIMESTAMPTZ,
    "last_sync_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT,
    "fields" JSONB NOT NULL DEFAULT '{}',
    "field_meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_identities" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "channel_id" TEXT,
    "customer_id" TEXT,
    "subject" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'new',
    "priority" "TicketPriority" NOT NULL DEFAULT 'normal',
    "department_id" TEXT,
    "department_locked" BOOLEAN NOT NULL DEFAULT false,
    "assignee_id" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fields" JSONB NOT NULL DEFAULT '{}',
    "field_meta" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "agent_state" "AgentState" NOT NULL DEFAULT 'idle',
    "agent_rerun_pending" BOOLEAN NOT NULL DEFAULT false,
    "analysis" JSONB,
    "conversation_external_id" TEXT,
    "last_message_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_response_at" TIMESTAMPTZ,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participants" (
    "ticket_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "ParticipantRole" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "participants_pkey" PRIMARY KEY ("ticket_id","email")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "channel_id" TEXT,
    "author_type" "MessageAuthorType" NOT NULL,
    "author_user_id" TEXT,
    "visibility" "MessageVisibility" NOT NULL,
    "source" "MessageSource" NOT NULL,
    "subject" TEXT,
    "body_text" TEXT NOT NULL,
    "body_html" TEXT,
    "body_clean" TEXT,
    "from_email" TEXT,
    "from_name" TEXT,
    "to" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "external_id" TEXT,
    "rfc_message_id" TEXT,
    "in_reply_to" TEXT,
    "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_automated" BOOLEAN NOT NULL DEFAULT false,
    "headers" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "message_id" TEXT,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ticket_id" TEXT,
    "message_id" TEXT,
    "channel_id" TEXT NOT NULL,
    "kind" "DeliveryKind" NOT NULL,
    "event" TEXT,
    "payload" JSONB,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "response_status" INTEGER,
    "scheduled_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ,
    "provider_message_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_definitions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "entity" "FieldEntity" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "FieldType" NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "validation" JSONB NOT NULL DEFAULT '{}',
    "agent_hint" TEXT NOT NULL DEFAULT '',
    "fill_mode" "FieldFillMode" NOT NULL DEFAULT 'manual',
    "agent_min_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "required_on" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scope_department_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "display" TEXT[] DEFAULT ARRAY['sidebar']::TEXT[],
    "pass_to_integration" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "departments_workspace_id_key_key" ON "departments"("workspace_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "channels_api_key_hash_key" ON "channels"("api_key_hash");

-- CreateIndex
CREATE INDEX "channels_workspace_id_idx" ON "channels"("workspace_id");

-- CreateIndex
CREATE INDEX "customers_workspace_id_idx" ON "customers"("workspace_id");

-- CreateIndex
CREATE INDEX "customer_identities_customer_id_idx" ON "customer_identities"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_identities_workspace_id_type_value_key" ON "customer_identities"("workspace_id", "type", "value");

-- CreateIndex
CREATE INDEX "tickets_workspace_id_status_last_message_at_idx" ON "tickets"("workspace_id", "status", "last_message_at");

-- CreateIndex
CREATE INDEX "tickets_workspace_id_department_id_idx" ON "tickets"("workspace_id", "department_id");

-- CreateIndex
CREATE INDEX "tickets_workspace_id_assignee_id_idx" ON "tickets"("workspace_id", "assignee_id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_workspace_id_number_key" ON "tickets"("workspace_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_channel_id_conversation_external_id_key" ON "tickets"("channel_id", "conversation_external_id");

-- CreateIndex
CREATE INDEX "messages_ticket_id_created_at_idx" ON "messages"("ticket_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_channel_id_external_id_key" ON "messages"("channel_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_workspace_id_rfc_message_id_key" ON "messages"("workspace_id", "rfc_message_id");

-- CreateIndex
CREATE INDEX "attachments_message_id_idx" ON "attachments"("message_id");

-- CreateIndex
CREATE INDEX "deliveries_message_id_idx" ON "deliveries"("message_id");

-- CreateIndex
CREATE INDEX "deliveries_ticket_id_idx" ON "deliveries"("ticket_id");

-- CreateIndex
CREATE INDEX "deliveries_status_scheduled_at_idx" ON "deliveries"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "ticket_events_ticket_id_created_at_idx" ON "ticket_events"("ticket_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "field_definitions_workspace_id_entity_key_key" ON "field_definitions"("workspace_id", "entity", "key");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_identities" ADD CONSTRAINT "customer_identities_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participants" ADD CONSTRAINT "participants_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_definitions" ADD CONSTRAINT "field_definitions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
