-- CreateEnum
CREATE TYPE "AssignmentMode" AS ENUM ('manual', 'round_robin');

-- CreateEnum
CREATE TYPE "AssigneeSource" AS ENUM ('manual', 'rule', 'auto', 'action');

-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "assignment_mode" "AssignmentMode" NOT NULL DEFAULT 'manual',
ADD COLUMN     "assignment_settings" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "last_assigned_user_id" TEXT;

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "accepting_tickets" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ticket_assignees" (
    "ticket_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source" "AssigneeSource" NOT NULL,
    "added_by_id" TEXT,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acted_at" TIMESTAMPTZ,

    CONSTRAINT "ticket_assignees_pkey" PRIMARY KEY ("ticket_id","user_id")
);

-- CreateIndex
CREATE INDEX "ticket_assignees_workspace_id_user_id_idx" ON "ticket_assignees"("workspace_id", "user_id");

-- AddForeignKey
ALTER TABLE "ticket_assignees" ADD CONSTRAINT "ticket_assignees_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_assignees" ADD CONSTRAINT "ticket_assignees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The single assignee becomes the first entry of the list; the time it was set is not known.
-- An assignment grants access to the ticket now, while it did not before: only an assignee who sees the ticket through
-- their own departments is kept. Closed tickets of a member restricted later, and tickets of removed members, kept their
-- assignee before; copying those would open tickets to people an admin cut off. The timeline keeps who was assigned.
INSERT INTO "ticket_assignees" ("ticket_id", "user_id", "workspace_id", "source", "added_at")
SELECT t."id", t."assignee_id", t."workspace_id", 'manual', t."updated_at"
FROM "tickets" t
JOIN "memberships" m ON m."workspace_id" = t."workspace_id" AND m."user_id" = t."assignee_id"
JOIN "users" u ON u."id" = t."assignee_id"
WHERE t."assignee_id" IS NOT NULL
  AND (
    u."is_superadmin" OR m."role" = 'admin' OR m."all_departments"
    OR (t."department_id" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "membership_departments" md
      WHERE md."workspace_id" = t."workspace_id" AND md."user_id" = t."assignee_id" AND md."department_id" = t."department_id"))
    OR (t."department_id" IS NULL AND EXISTS (
      SELECT 1 FROM "membership_departments" md JOIN "departments" d ON d."id" = md."department_id"
      WHERE md."workspace_id" = t."workspace_id" AND md."user_id" = t."assignee_id" AND d."is_triage"))
  );

-- DropForeignKey
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_assignee_id_fkey";

-- DropIndex
DROP INDEX "tickets_workspace_id_assignee_id_idx";

-- AlterTable
ALTER TABLE "tickets" DROP COLUMN "assignee_id";
