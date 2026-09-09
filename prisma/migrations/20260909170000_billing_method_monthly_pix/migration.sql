-- Mensal no Pix: quarta forma de pagamento.
--
-- Escrita à mão de propósito. `prisma migrate dev` não conhece o índice único PARCIAL
-- `billing_charges_one_open_per_intent` (SQL cru) e o DERRUBA ao reconciliar o schema —
-- foi o que aconteceu em `20260730124301_company_invites`, que o apagou sem ninguém
-- notar. Esta migration não toca `billing_charges`, então o índice não corre risco;
-- `test/billing-repository.e2e-spec.ts` confere isso contra o banco de qualquer forma.
--
-- O mecanismo é o mesmo do `annual_pix` (assinatura nativa do Asaas com billingType
-- PIX), só com cycle MONTHLY. Não é Pix Automático: naquele o valor fica congelado no
-- consentimento do pagador, o que é incompatível com o preço por assento.

ALTER TYPE "billing_method" ADD VALUE 'monthly_pix';
