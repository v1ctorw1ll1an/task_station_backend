-- AlterEnum
ALTER TYPE "membership_role" ADD VALUE 'project_admin';

-- CreateTable
CREATE TABLE "project_restrictions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_restrictions_user_id_idx" ON "project_restrictions"("user_id");

-- CreateIndex
CREATE INDEX "project_restrictions_project_id_idx" ON "project_restrictions"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_restrictions_user_id_project_id_key" ON "project_restrictions"("user_id", "project_id");

-- AddForeignKey
ALTER TABLE "project_restrictions" ADD CONSTRAINT "project_restrictions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_restrictions" ADD CONSTRAINT "project_restrictions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
