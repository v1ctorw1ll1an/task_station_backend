-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "seat_proration_invoice_id" TEXT,
ADD COLUMN     "seat_proration_invoiced_cents" INTEGER NOT NULL DEFAULT 0;
