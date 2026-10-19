-- Direção da sincronização com o Google Agenda, controlada pelo superusuário.
-- Linha única ('global'); sem linha, vale 'both' (comportamento anterior).
CREATE TYPE "google_sync_direction" AS ENUM ('both', 'google_to_app', 'app_to_google');

CREATE TABLE "google_calendar_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "sync_direction" "google_sync_direction" NOT NULL DEFAULT 'both',
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_calendar_settings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "google_calendar_settings" ADD CONSTRAINT "google_calendar_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
