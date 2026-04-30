-- CreateTable
CREATE TABLE "calendar_event_guest_emails" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_event_guest_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_event_guest_emails_event_id_idx" ON "calendar_event_guest_emails"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_guest_emails_event_id_email_key" ON "calendar_event_guest_emails"("event_id", "email");

-- AddForeignKey
ALTER TABLE "calendar_event_guest_emails" ADD CONSTRAINT "calendar_event_guest_emails_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
