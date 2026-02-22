-- CreateEnum
CREATE TYPE "token_type" AS ENUM ('password_reset', 'first_access');

-- AlterTable: add column with default so existing rows get 'password_reset'
ALTER TABLE "password_reset_tokens"
  ADD COLUMN "type" "token_type" NOT NULL DEFAULT 'password_reset';

-- DropIndex (old 3-column index)
DROP INDEX "password_reset_tokens_user_id_used_at_expires_at_idx";

-- CreateIndex (new 4-column index covering type)
CREATE INDEX "password_reset_tokens_user_id_type_used_at_expires_at_idx"
  ON "password_reset_tokens"("user_id", "type", "used_at", "expires_at");
