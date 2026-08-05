-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('trial', 'active', 'past_due', 'readonly', 'canceled', 'courtesy');

-- CreateEnum
CREATE TYPE "billing_method" AS ENUM ('monthly_card', 'annual_pix', 'annual_card');

-- CreateEnum
CREATE TYPE "charge_type" AS ENUM ('subscription', 'renewal', 'seat_proration');

-- CreateEnum
CREATE TYPE "charge_status" AS ENUM ('pending', 'paid', 'failed', 'expired', 'canceled', 'refunded');

-- CreateEnum
CREATE TYPE "payment_kind" AS ENUM ('credit_card', 'pix');

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "status" "subscription_status" NOT NULL DEFAULT 'trial',
    "method" "billing_method",
    "purchased_seats" INTEGER NOT NULL DEFAULT 1,
    "seats_at_next_renewal" INTEGER,
    "trial_ends_at" TIMESTAMPTZ,
    "current_period_start" TIMESTAMPTZ,
    "current_period_end" TIMESTAMPTZ,
    "grace_until" TIMESTAMPTZ,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "superadmin_locked" BOOLEAN NOT NULL DEFAULT false,
    "asaas_customer_id" TEXT,
    "asaas_subscription_id" TEXT,
    "asaas_card_token" TEXT,
    "card_brand" TEXT,
    "card_last_four" TEXT,
    "canceled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_charges" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "type" "charge_type" NOT NULL,
    "payment_kind" "payment_kind" NOT NULL,
    "status" "charge_status" NOT NULL DEFAULT 'pending',
    "amount_cents" INTEGER NOT NULL,
    "installments" INTEGER NOT NULL DEFAULT 1,
    "seats" INTEGER NOT NULL,
    "seats_delta" INTEGER,
    "period_start" TIMESTAMPTZ,
    "period_end" TIMESTAMPTZ,
    "asaas_payment_id" TEXT,
    "card_brand" TEXT,
    "card_last_four" TEXT,
    "pix_payload" TEXT,
    "pix_encoded_image" TEXT,
    "pix_expires_at" TIMESTAMPTZ,
    "invoice_url" TEXT,
    "paid_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,
    "fail_reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "asaas_event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "asaas_payment_id" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "processed_at" TIMESTAMPTZ,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_notices" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "anchor_at" TIMESTAMPTZ NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_company_id_key" ON "subscriptions"("company_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_current_period_end_idx" ON "subscriptions"("status", "current_period_end");

-- CreateIndex
CREATE INDEX "subscriptions_status_trial_ends_at_idx" ON "subscriptions"("status", "trial_ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_charges_asaas_payment_id_key" ON "billing_charges"("asaas_payment_id");

-- CreateIndex
CREATE INDEX "billing_charges_company_id_created_at_idx" ON "billing_charges"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "billing_charges_status_pix_expires_at_idx" ON "billing_charges"("status", "pix_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_asaas_event_id_key" ON "webhook_events"("asaas_event_id");

-- CreateIndex
CREATE INDEX "webhook_events_type_created_at_idx" ON "webhook_events"("type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_notices_subscription_id_kind_anchor_at_key" ON "billing_notices"("subscription_id", "kind", "anchor_at");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_charges" ADD CONSTRAINT "billing_charges_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: empresas já existentes entram como "courtesy" (isentas, com acesso
-- total) até o superusuário decidir caso a caso. purchased_seats = assentos já
-- ocupados (memberships ativas de empresa), no mínimo 1 (o criador).
INSERT INTO "subscriptions" ("id", "company_id", "status", "purchased_seats", "created_at", "updated_at")
SELECT
    gen_random_uuid(),
    c."id",
    'courtesy',
    GREATEST(1, (
        SELECT COUNT(*)
        FROM "memberships" m
        WHERE m."resource_type" = 'company'
          AND m."resource_id" = c."id"
          AND m."deleted_at" IS NULL
    )),
    now(),
    now()
FROM "companies" c
WHERE c."deleted_at" IS NULL;
