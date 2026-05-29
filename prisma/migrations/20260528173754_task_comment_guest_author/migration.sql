-- AlterTable
ALTER TABLE "task_comments" ADD COLUMN     "guest_id" TEXT,
ALTER COLUMN "user_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "task_guests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
