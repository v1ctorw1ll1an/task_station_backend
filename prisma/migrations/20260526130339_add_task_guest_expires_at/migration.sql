-- Adiciona expiração opcional aos guest tokens (TTL).
-- Linhas existentes ficam com NULL = sem expiração, mantendo compat. retroativa.
ALTER TABLE "task_guests" ADD COLUMN "expires_at" TIMESTAMP(3);
