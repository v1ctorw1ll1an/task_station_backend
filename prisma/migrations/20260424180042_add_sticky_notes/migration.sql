-- CreateEnum
CREATE TYPE "sticky_note_color" AS ENUM ('yellow', 'blue', 'green', 'pink', 'purple', 'gray');

-- CreateTable
CREATE TABLE "sticky_notes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "content" VARCHAR(255) NOT NULL DEFAULT '',
    "color" "sticky_note_color" NOT NULL DEFAULT 'yellow',
    "x" INTEGER NOT NULL DEFAULT 0,
    "y" INTEGER NOT NULL DEFAULT 0,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "minimized" BOOLEAN NOT NULL DEFAULT false,
    "z_index" INTEGER NOT NULL DEFAULT 1000,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "sticky_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sticky_note_task_links" (
    "note_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,

    CONSTRAINT "sticky_note_task_links_pkey" PRIMARY KEY ("note_id","task_id")
);

-- CreateIndex
CREATE INDEX "sticky_notes_user_id_deleted_at_idx" ON "sticky_notes"("user_id", "deleted_at");

-- CreateIndex
CREATE INDEX "sticky_note_task_links_task_id_idx" ON "sticky_note_task_links"("task_id");

-- AddForeignKey
ALTER TABLE "sticky_notes" ADD CONSTRAINT "sticky_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sticky_note_task_links" ADD CONSTRAINT "sticky_note_task_links_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "sticky_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sticky_note_task_links" ADD CONSTRAINT "sticky_note_task_links_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
