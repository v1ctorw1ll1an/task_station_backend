-- Cor do calendário do Google (paleta atual da interface), usada para pintar os
-- eventos importados dele. Preenchida no próximo full resync, que também recolore
-- os eventos já importados que estavam sem cor.
ALTER TABLE "google_calendar_sources" ADD COLUMN "color" TEXT;
