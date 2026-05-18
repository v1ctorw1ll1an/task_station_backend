-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'EVENT_REMINDER';

-- AlterTable
ALTER TABLE "notification_preferences"
  ADD COLUMN "event_reminder"          BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "event_reminder_sound"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "event_reminder_popup"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "event_reminder_browser"  BOOLEAN NOT NULL DEFAULT true;
