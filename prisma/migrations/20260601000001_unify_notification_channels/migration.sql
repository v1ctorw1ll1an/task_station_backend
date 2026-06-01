-- Som e notificação do sistema passaram a ser canais GLOBAIS
-- (notification_sound / notification_browser), valendo também para lembretes
-- de evento. Os canais dedicados de evento para som/sistema ficam redundantes
-- e são removidos. O popup in-app (event_reminder_popup) permanece.

-- AlterTable
ALTER TABLE "notification_preferences"
  DROP COLUMN "event_reminder_sound",
  DROP COLUMN "event_reminder_browser";
