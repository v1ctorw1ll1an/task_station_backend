-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "billing_address_complement" TEXT,
ADD COLUMN     "billing_address_number" TEXT,
ADD COLUMN     "billing_cpf_cnpj" TEXT,
ADD COLUMN     "billing_email" TEXT,
ADD COLUMN     "billing_name" TEXT,
ADD COLUMN     "billing_phone" TEXT,
ADD COLUMN     "billing_postal_code" TEXT;
