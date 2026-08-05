-- Segurança: não armazenamos nenhum dado de cartão. O cartão só transita para o
-- Asaas no momento da operação (tokenização) e nunca é persistido. Para o mensal
-- recorrente, o token fica no Asaas (referenciado por asaas_subscription_id).

ALTER TABLE "subscriptions"
  DROP COLUMN IF EXISTS "asaas_card_token",
  DROP COLUMN IF EXISTS "card_brand",
  DROP COLUMN IF EXISTS "card_last_four";

ALTER TABLE "billing_charges"
  DROP COLUMN IF EXISTS "card_brand",
  DROP COLUMN IF EXISTS "card_last_four";
