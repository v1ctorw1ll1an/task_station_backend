-- Opção por evento: o dono decide se aquele evento vai para o Google Agenda dele.
-- Eventos existentes seguem sincronizando (comportamento anterior).
ALTER TABLE "calendar_events" ADD COLUMN "sync_to_google" BOOLEAN NOT NULL DEFAULT true;
