-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "all_departments" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "membership_departments" (
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_departments_pkey" PRIMARY KEY ("workspace_id","user_id","department_id")
);

-- CreateIndex
CREATE INDEX "membership_departments_department_id_idx" ON "membership_departments"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_id_workspace_id_key" ON "departments"("id", "workspace_id");

-- AddForeignKey
ALTER TABLE "membership_departments" ADD CONSTRAINT "membership_departments_workspace_id_user_id_fkey" FOREIGN KEY ("workspace_id", "user_id") REFERENCES "memberships"("workspace_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_departments" ADD CONSTRAINT "membership_departments_department_id_workspace_id_fkey" FOREIGN KEY ("department_id", "workspace_id") REFERENCES "departments"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Admins always see every department.
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_admin_all_departments" CHECK ("role" <> 'admin' OR "all_departments");
