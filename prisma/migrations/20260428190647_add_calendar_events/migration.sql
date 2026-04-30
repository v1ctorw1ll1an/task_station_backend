-- CreateEnum
CREATE TYPE "event_visibility" AS ENUM ('private', 'shared');

-- CreateEnum
CREATE TYPE "attendee_status" AS ENUM ('invited', 'accepted', 'declined', 'tentative');

-- CreateEnum
CREATE TYPE "reminder_method" AS ENUM ('notification', 'email');

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "company_id" TEXT,
    "workspace_id" TEXT,
    "task_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "color" TEXT,
    "all_day" BOOLEAN NOT NULL DEFAULT false,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "rrule" TEXT,
    "recurrence_end_at" TIMESTAMPTZ,
    "visibility" "event_visibility" NOT NULL DEFAULT 'private',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_attendees" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "attendee_status" NOT NULL DEFAULT 'invited',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_event_attendees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_reminders" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "minutes_before" INTEGER NOT NULL,
    "method" "reminder_method" NOT NULL DEFAULT 'notification',

    CONSTRAINT "calendar_event_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_exceptions" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "original_date" TIMESTAMPTZ NOT NULL,
    "is_cancelled" BOOLEAN NOT NULL DEFAULT false,
    "override_title" TEXT,
    "override_description" TEXT,
    "override_starts_at" TIMESTAMPTZ,
    "override_ends_at" TIMESTAMPTZ,
    "override_location" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_event_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_events_owner_id_deleted_at_idx" ON "calendar_events"("owner_id", "deleted_at");

-- CreateIndex
CREATE INDEX "calendar_events_starts_at_deleted_at_idx" ON "calendar_events"("starts_at", "deleted_at");

-- CreateIndex
CREATE INDEX "calendar_events_workspace_id_deleted_at_idx" ON "calendar_events"("workspace_id", "deleted_at");

-- CreateIndex
CREATE INDEX "calendar_event_attendees_user_id_idx" ON "calendar_event_attendees"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_attendees_event_id_user_id_key" ON "calendar_event_attendees"("event_id", "user_id");

-- CreateIndex
CREATE INDEX "calendar_event_reminders_event_id_idx" ON "calendar_event_reminders"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_exceptions_event_id_original_date_key" ON "calendar_event_exceptions"("event_id", "original_date");

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_reminders" ADD CONSTRAINT "calendar_event_reminders_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_exceptions" ADD CONSTRAINT "calendar_event_exceptions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
