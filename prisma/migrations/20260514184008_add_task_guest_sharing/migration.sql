-- AlterTable
ALTER TABLE "task_history" ADD COLUMN     "guest_id" TEXT,
ALTER COLUMN "user_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "task_guests" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "email" TEXT,
    "token_hash" TEXT NOT NULL,
    "invited_by" TEXT NOT NULL,
    "invited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_accessed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "task_guests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "task_guests_token_hash_key" ON "task_guests"("token_hash");

-- CreateIndex
CREATE INDEX "task_guests_task_id_deleted_at_idx" ON "task_guests"("task_id", "deleted_at");

-- CreateIndex
CREATE INDEX "task_guests_token_hash_idx" ON "task_guests"("token_hash");

-- AddForeignKey
ALTER TABLE "task_history" ADD CONSTRAINT "task_history_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "task_guests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_guests" ADD CONSTRAINT "task_guests_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_guests" ADD CONSTRAINT "task_guests_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
