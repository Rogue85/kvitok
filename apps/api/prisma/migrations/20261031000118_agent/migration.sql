-- CreateEnum
CREATE TYPE "AgentRunMode" AS ENUM ('triage', 'refine', 'revise_reply');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('queued', 'running', 'applied', 'stale', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "DraftSource" AS ENUM ('agent', 'operator');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('current', 'suggested', 'superseded', 'sent', 'discarded');

-- CreateEnum
CREATE TYPE "AgentQuestionStatus" AS ENUM ('open', 'answered', 'dismissed');

-- CreateEnum
CREATE TYPE "RuleStage" AS ENUM ('on_ingest', 'after_agent');

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "answers_question_id" TEXT;

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "agent_pending" JSONB;

-- CreateTable
CREATE TABLE "llm_providers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'openai_compatible',
    "base_url" TEXT NOT NULL,
    "secrets" TEXT,
    "models" JSONB NOT NULL DEFAULT '[]',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "llm_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_settings" (
    "workspace_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider_id" TEXT,
    "model" TEXT,
    "revise_model" TEXT,
    "policy" TEXT NOT NULL DEFAULT '',
    "playbook_mode" TEXT NOT NULL DEFAULT 'on_demand',
    "max_tool_calls" INTEGER NOT NULL DEFAULT 8,
    "max_output_tokens" INTEGER NOT NULL DEFAULT 2000,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "confidence_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "debounce_seconds" INTEGER NOT NULL DEFAULT 30,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agent_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "playbooks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "when" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "department_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'ui',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "playbooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_config_versions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_config_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "mode" "AgentRunMode" NOT NULL,
    "trigger" JSONB NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'queued',
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "input_revision" INTEGER NOT NULL,
    "config_version_id" TEXT,
    "model" TEXT,
    "input_snapshot" JSONB,
    "output" JSONB,
    "error" TEXT,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION,
    "currency" TEXT,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_steps" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_questions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "AgentQuestionStatus" NOT NULL DEFAULT 'open',
    "answer_message_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agent_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reply_drafts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" "DraftSource" NOT NULL,
    "run_id" TEXT,
    "user_id" TEXT,
    "body_html" TEXT NOT NULL,
    "based_on_revision" INTEGER NOT NULL,
    "status" "DraftStatus" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "reply_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_rules" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stage" "RuleStage" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "conditions" JSONB NOT NULL,
    "effects" JSONB NOT NULL,
    "stop" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_providers_workspace_id_idx" ON "llm_providers"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "playbooks_workspace_id_key_key" ON "playbooks"("workspace_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "agent_config_versions_workspace_id_number_key" ON "agent_config_versions"("workspace_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "agent_config_versions_workspace_id_hash_key" ON "agent_config_versions"("workspace_id", "hash");

-- CreateIndex
CREATE INDEX "agent_runs_ticket_id_created_at_idx" ON "agent_runs"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_steps_run_id_index_idx" ON "agent_steps"("run_id", "index");

-- CreateIndex
CREATE INDEX "agent_questions_ticket_id_status_idx" ON "agent_questions"("ticket_id", "status");

-- CreateIndex
CREATE INDEX "reply_drafts_ticket_id_status_idx" ON "reply_drafts"("ticket_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reply_drafts_ticket_id_version_key" ON "reply_drafts"("ticket_id", "version");

-- CreateIndex
CREATE INDEX "routing_rules_workspace_id_stage_position_idx" ON "routing_rules"("workspace_id", "stage", "position");

-- AddForeignKey
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_config_version_id_fkey" FOREIGN KEY ("config_version_id") REFERENCES "agent_config_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
