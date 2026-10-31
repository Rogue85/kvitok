-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "agent_job_id" TEXT,
ADD COLUMN     "agent_skipped" BOOLEAN NOT NULL DEFAULT false;
