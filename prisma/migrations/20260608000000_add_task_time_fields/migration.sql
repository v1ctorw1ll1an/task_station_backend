-- Task ganha horário de início/término, seguindo as mesmas regras do evento.
-- start_date/due_date passam de DATE para TIMESTAMPTZ e a task ganha all_day +
-- timezone (espelhando CalendarEvent.allDay / CalendarEvent.timezone).

-- AlterTable: novos campos
ALTER TABLE "tasks"
  ADD COLUMN "all_day" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo';

-- AlterTable: promover DATE -> TIMESTAMPTZ.
-- Converte cada data existente para a meia-noite no fuso America/Sao_Paulo
-- (mesma convenção do front em combineDateAndTime), evitando deslocar o dia
-- ao exibir. Linhas NULL permanecem NULL.
ALTER TABLE "tasks"
  ALTER COLUMN "start_date" TYPE TIMESTAMPTZ
    USING ("start_date"::timestamp AT TIME ZONE 'America/Sao_Paulo'),
  ALTER COLUMN "due_date" TYPE TIMESTAMPTZ
    USING ("due_date"::timestamp AT TIME ZONE 'America/Sao_Paulo');
