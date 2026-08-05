-- Checkout hospedado do Asaas + fim da proração + assentos anuais como assinatura própria.
--
-- Escrita à mão (o `migrate dev` é interativo neste ambiente) por dois motivos que o
-- gerador não resolveria bem:
--   1. o valor do enum é RENOMEADO, não recriado — as cobranças existentes de assento
--      continuam válidas com o rótulo novo;
--   2. o índice único PARCIAL de `billing_charges` não é expressável no schema Prisma e
--      precisa voltar em SQL cru (foi apagado sem querer em `20260730124301`).

-- ── Enum: proração deixa de existir; a cobrança de assento passa a ser valor cheio ──
ALTER TYPE "charge_type" RENAME VALUE 'seat_proration' TO 'seat';

-- ── Subscription: fora a proração acumulada, entra o contador de add-ons e o endereço ──
ALTER TABLE "subscriptions"
  DROP COLUMN "seat_proration_accrued_cents",
  DROP COLUMN "seat_proration_invoiced_cents",
  DROP COLUMN "seat_proration_invoice_id",
  ADD COLUMN "addon_seats" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "billing_street" TEXT,
  ADD COLUMN "billing_neighborhood" TEXT,
  ADD COLUMN "billing_city" TEXT,
  ADD COLUMN "billing_state" TEXT;

-- ── Assentos adicionais do plano anual: uma assinatura no Asaas por compra ──
CREATE TYPE "seat_addon_status" AS ENUM ('pending', 'active', 'past_due', 'canceled');

CREATE TABLE "seat_addons" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "payment_kind" "payment_kind" NOT NULL,
    "status" "seat_addon_status" NOT NULL DEFAULT 'pending',
    "asaas_subscription_id" TEXT,
    "current_period_start" TIMESTAMPTZ,
    "current_period_end" TIMESTAMPTZ,
    "grace_until" TIMESTAMPTZ,
    "activated_at" TIMESTAMPTZ,
    "canceled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seat_addons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "seat_addons_asaas_subscription_id_key" ON "seat_addons"("asaas_subscription_id");
CREATE INDEX "seat_addons_company_id_status_idx" ON "seat_addons"("company_id", "status");
CREATE INDEX "seat_addons_status_current_period_end_idx" ON "seat_addons"("status", "current_period_end");

ALTER TABLE "seat_addons" ADD CONSTRAINT "seat_addons_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "seat_addons" ADD CONSTRAINT "seat_addons_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── BillingCharge: o checkout hospedado e o vínculo com o add-on ──
ALTER TABLE "billing_charges"
  ADD COLUMN "seat_addon_id" TEXT,
  ADD COLUMN "asaas_checkout_id" TEXT,
  ADD COLUMN "checkout_url" TEXT,
  ADD COLUMN "checkout_expires_at" TIMESTAMPTZ;

CREATE UNIQUE INDEX "billing_charges_asaas_checkout_id_key" ON "billing_charges"("asaas_checkout_id");
CREATE INDEX "billing_charges_status_checkout_expires_at_idx" ON "billing_charges"("status", "checkout_expires_at");

ALTER TABLE "billing_charges" ADD CONSTRAINT "billing_charges_seat_addon_id_fkey"
  FOREIGN KEY ("seat_addon_id") REFERENCES "seat_addons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── WebhookEvent: eventos CHECKOUT_* não trazem cobrança ──
ALTER TABLE "webhook_events" ADD COLUMN "asaas_checkout_id" TEXT;
CREATE INDEX "webhook_events_asaas_checkout_id_idx" ON "webhook_events"("asaas_checkout_id");

-- ── Índices perdidos em `20260730124301_company_invites` ──
-- A trava final contra duas cobranças abertas do mesmo intento. `prisma migrate dev` não
-- conhece índice parcial e o derrubou junto com o schema reconciliado; `IF NOT EXISTS`
-- deixa esta migration idempotente caso alguém já o tenha recriado à mão.
CREATE UNIQUE INDEX IF NOT EXISTS "billing_charges_one_open_per_intent"
  ON "billing_charges" ("subscription_id", "type")
  WHERE "status" = 'pending' AND "type" IN ('subscription', 'seat');

CREATE INDEX IF NOT EXISTS "memberships_scheduled_removal_at_idx"
  ON "memberships"("scheduled_removal_at");
