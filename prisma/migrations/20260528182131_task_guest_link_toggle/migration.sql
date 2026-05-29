-- AlterTable
ALTER TABLE "task_guests" ADD COLUMN     "link_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "raw_token" TEXT;
