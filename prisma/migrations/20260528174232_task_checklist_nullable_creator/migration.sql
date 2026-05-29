-- DropForeignKey
ALTER TABLE "task_checklists" DROP CONSTRAINT "task_checklists_created_by_fkey";

-- AlterTable
ALTER TABLE "task_checklists" ALTER COLUMN "created_by" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "task_checklists" ADD CONSTRAINT "task_checklists_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
