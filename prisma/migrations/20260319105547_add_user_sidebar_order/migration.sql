/*
  Warnings:

  - You are about to drop the column `notification_id` on the `tasks` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "task_history" DROP CONSTRAINT "task_history_task_id_fkey";

-- DropForeignKey
ALTER TABLE "task_history" DROP CONSTRAINT "task_history_user_id_fkey";

-- DropIndex
DROP INDEX "task_history_changed_at_idx";

-- AlterTable
ALTER TABLE "task_history" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "field" SET DATA TYPE TEXT,
ALTER COLUMN "changed_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tasks" DROP COLUMN "notification_id";

-- CreateTable
CREATE TABLE "user_workspace_orders" (
    "user_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "user_workspace_orders_pkey" PRIMARY KEY ("user_id","workspace_id")
);

-- CreateTable
CREATE TABLE "user_project_orders" (
    "user_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "user_project_orders_pkey" PRIMARY KEY ("user_id","project_id")
);

-- CreateIndex
CREATE INDEX "user_workspace_orders_user_id_company_id_idx" ON "user_workspace_orders"("user_id", "company_id");

-- CreateIndex
CREATE INDEX "user_project_orders_user_id_workspace_id_idx" ON "user_project_orders"("user_id", "workspace_id");

-- CreateIndex
CREATE INDEX "task_history_changed_at_idx" ON "task_history"("changed_at");

-- AddForeignKey
ALTER TABLE "task_history" ADD CONSTRAINT "task_history_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_history" ADD CONSTRAINT "task_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_workspace_orders" ADD CONSTRAINT "user_workspace_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_workspace_orders" ADD CONSTRAINT "user_workspace_orders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_project_orders" ADD CONSTRAINT "user_project_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_project_orders" ADD CONSTRAINT "user_project_orders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_project_orders" ADD CONSTRAINT "user_project_orders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
