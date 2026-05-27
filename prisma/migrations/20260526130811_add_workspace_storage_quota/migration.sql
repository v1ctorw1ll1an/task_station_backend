-- Cota de armazenamento por workspace, padrão 10 GiB.
-- A app valida a soma de TaskAttachment.size do workspace antes de aceitar upload.
ALTER TABLE "workspaces"
  ADD COLUMN "storage_quota_bytes" BIGINT NOT NULL DEFAULT 10737418240;
