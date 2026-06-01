-- AlterTable
ALTER TABLE "notification_preferences"
  ADD COLUMN "notification_sound"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notification_browser"  BOOLEAN NOT NULL DEFAULT true;
