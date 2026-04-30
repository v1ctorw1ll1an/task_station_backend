-- AlterTable
ALTER TABLE "calendar_event_reminders" ALTER COLUMN "method" SET DEFAULT 'email';

-- CreateTable
CREATE TABLE "calendar_event_reminders_sent" (
    "id" TEXT NOT NULL,
    "reminder_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "original_date" TIMESTAMPTZ NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_event_reminders_sent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_reminders_sent_reminder_id_recipient_id_orig_key" ON "calendar_event_reminders_sent"("reminder_id", "recipient_id", "original_date");

-- AddForeignKey
ALTER TABLE "calendar_event_reminders_sent" ADD CONSTRAINT "calendar_event_reminders_sent_reminder_id_fkey" FOREIGN KEY ("reminder_id") REFERENCES "calendar_event_reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
