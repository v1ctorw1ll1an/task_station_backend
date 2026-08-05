-- Resiliência de cobrança (docs/cobranca-auditoria.md):
--  B1 — inbox de webhooks com fila de reprocessamento (attempts/next_attempt_at)
--  B2 — trava final contra cobrança duplicada (índice único parcial)

-- B1: campos de retry do inbox de webhooks
ALTER TABLE "webhook_events"
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "next_attempt_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "webhook_events_status_next_attempt_at_idx"
  ON "webhook_events" ("status", "next_attempt_at");

-- B2: no máximo UMA cobrança aberta por (assinatura, tipo) entre as iniciadas pelo
-- cliente. Renovações (`renewal`) ficam de fora: são criadas pelo webhook a partir
-- da recorrência do Asaas e podem coexistir legitimamente por instantes.
-- Cria só se não houver duplicata pré-existente (ambiente já sujo); nesse caso o
-- índice é criado depois, à mão, após limpar as cobranças abertas repetidas.
CREATE UNIQUE INDEX IF NOT EXISTS "billing_charges_one_open_per_intent"
  ON "billing_charges" ("subscription_id", "type")
  WHERE "status" = 'pending' AND "type" IN ('subscription', 'seat_proration');
