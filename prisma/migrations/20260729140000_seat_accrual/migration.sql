-- Compra de assento no plano MENSAL deixa de gerar cobrança avulsa (R17): o assento
-- entra na hora e a proração dos dias restantes do ciclo é acumulada aqui para ser
-- somada à próxima fatura da assinatura recorrente. Zera quando essa fatura é paga.
--
-- Guardar o acumulado (em vez de mexer só no valor da fatura no Asaas) é o que torna
-- a operação idempotente: a fatura pendente recebe sempre o valor ABSOLUTO
-- `mensalidade + acumulado`, então reexecutar a sincronização nunca cobra em dobro.
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "seat_proration_accrued_cents" INTEGER NOT NULL DEFAULT 0;
