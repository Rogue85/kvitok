-- AlterTable
ALTER TABLE "action_proposals" ADD COLUMN     "created_by_id" TEXT,
ADD COLUMN     "refresh_draft" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "replaced_by_id" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'agent';

-- AddForeignKey
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
