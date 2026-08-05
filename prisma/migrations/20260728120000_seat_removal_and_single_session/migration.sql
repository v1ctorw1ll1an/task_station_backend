-- Assento devolvido na renovação: o admin escolhe quem sai, a saída vale quando o
-- ciclo pago terminar (R19).
ALTER TABLE "memberships"
  ADD COLUMN IF NOT EXISTS "scheduled_removal_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "memberships_scheduled_removal_at_idx"
  ON "memberships" ("resource_type", "resource_id")
  WHERE "scheduled_removal_at" IS NOT NULL AND "deleted_at" IS NULL;

-- Um assento = um login: sessão única por usuário (o último login vence).
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "active_session_id" TEXT;
