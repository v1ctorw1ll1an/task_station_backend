-- Integração Agenda TaskDY ↔ Google Calendar: conexão OAuth, calendários sincronizados,
-- mapeamento item↔evento Google e outbox de jobs (o projeto não tem fila).
--
-- Escrita à mão a partir do `prisma migrate diff` do schema: não toca `billing_charges`
-- (ver o aviso sobre o índice parcial em 20260909170000_billing_method_monthly_pix).

-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'INTEGRATION_ALERT';

-- CreateEnum
CREATE TYPE "google_connection_status" AS ENUM ('active', 'revoked', 'error');

-- CreateEnum
CREATE TYPE "google_link_kind" AS ENUM ('event', 'task');

-- CreateEnum
CREATE TYPE "google_link_origin" AS ENUM ('taskdy', 'google');

-- CreateEnum
CREATE TYPE "calendar_sync_job_kind" AS ENUM ('push_event', 'push_task', 'pull_source', 'full_resync');

-- AlterTable
ALTER TABLE "calendar_events" ADD COLUMN     "external_read_only" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "google_calendar_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "google_account_id" TEXT NOT NULL,
    "google_email" TEXT NOT NULL,
    "refresh_token_enc" TEXT,
    "access_token_enc" TEXT,
    "access_token_expires_at" TIMESTAMPTZ,
    "taskdy_calendar_id" TEXT,
    "status" "google_connection_status" NOT NULL DEFAULT 'active',
    "last_sync_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_calendar_sources" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "google_calendar_id" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "access_role" TEXT NOT NULL,
    "time_zone" TEXT,
    "is_taskdy_calendar" BOOLEAN NOT NULL DEFAULT false,
    "import_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sync_token" TEXT,
    "channel_id" TEXT,
    "channel_resource_id" TEXT,
    "channel_token_hash" TEXT,
    "channel_expires_at" TIMESTAMPTZ,
    "last_pulled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_calendar_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_event_links" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "google_event_id" TEXT NOT NULL,
    "kind" "google_link_kind" NOT NULL,
    "calendar_event_id" TEXT,
    "task_id" TEXT,
    "etag" TEXT,
    "google_updated_at" TIMESTAMPTZ,
    "local_updated_at" TIMESTAMPTZ,
    "read_only" BOOLEAN NOT NULL DEFAULT false,
    "origin" "google_link_origin" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_event_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_sync_jobs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "calendar_sync_job_kind" NOT NULL,
    "ref_id" TEXT NOT NULL DEFAULT '',
    "run_after" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enqueued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "google_calendar_connections_user_id_key" ON "google_calendar_connections"("user_id");

-- CreateIndex
CREATE INDEX "google_calendar_connections_status_idx" ON "google_calendar_connections"("status");

-- CreateIndex
CREATE UNIQUE INDEX "google_calendar_sources_channel_id_key" ON "google_calendar_sources"("channel_id");

-- CreateIndex
CREATE INDEX "google_calendar_sources_channel_expires_at_idx" ON "google_calendar_sources"("channel_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "google_calendar_sources_connection_id_google_calendar_id_key" ON "google_calendar_sources"("connection_id", "google_calendar_id");

-- CreateIndex
CREATE INDEX "google_event_links_calendar_event_id_idx" ON "google_event_links"("calendar_event_id");

-- CreateIndex
CREATE INDEX "google_event_links_task_id_idx" ON "google_event_links"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "google_event_links_source_id_google_event_id_key" ON "google_event_links"("source_id", "google_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "google_event_links_connection_id_calendar_event_id_key" ON "google_event_links"("connection_id", "calendar_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "google_event_links_connection_id_task_id_key" ON "google_event_links"("connection_id", "task_id");

-- CreateIndex
CREATE INDEX "calendar_sync_jobs_run_after_idx" ON "calendar_sync_jobs"("run_after");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_sync_jobs_user_id_kind_ref_id_key" ON "calendar_sync_jobs"("user_id", "kind", "ref_id");

-- AddForeignKey
ALTER TABLE "google_calendar_connections" ADD CONSTRAINT "google_calendar_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_calendar_sources" ADD CONSTRAINT "google_calendar_sources_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "google_calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_event_links" ADD CONSTRAINT "google_event_links_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "google_calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_event_links" ADD CONSTRAINT "google_event_links_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "google_calendar_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_event_links" ADD CONSTRAINT "google_event_links_calendar_event_id_fkey" FOREIGN KEY ("calendar_event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_event_links" ADD CONSTRAINT "google_event_links_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
