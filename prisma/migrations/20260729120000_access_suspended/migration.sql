-- Suspensão total (R44): estado próprio, separado do somente-leitura manual.
-- `superadmin_locked` = a empresa continua usando o app, sem criar/alterar.
-- `access_suspended`  = porta fechada (nem leitura), para fraude/abuso/ordem judicial.
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "access_suspended" BOOLEAN NOT NULL DEFAULT false;
