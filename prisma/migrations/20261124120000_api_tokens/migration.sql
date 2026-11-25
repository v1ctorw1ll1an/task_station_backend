-- Tokens de acesso pessoal (PAT) para clientes externos (servidor MCP do Claude Code).
-- Autenticam como o usuário sem ocupar o assento; travados num workspace.
-- Só o hash SHA-256 do token é guardado.

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "last_used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "api_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "api_tokens_user_id_revoked_at_idx" ON "api_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "api_tokens_workspace_id_idx" ON "api_tokens"("workspace_id");

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
