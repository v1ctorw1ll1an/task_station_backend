-- Último login do usuário, para o superusuário enxergar períodos de inatividade.
-- Sem backfill: não há histórico de login anterior a esta coluna.
ALTER TABLE "users" ADD COLUMN "last_login_at" TIMESTAMPTZ;
