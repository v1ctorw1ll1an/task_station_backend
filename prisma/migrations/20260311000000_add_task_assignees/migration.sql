-- Create task_assignees join table
CREATE TABLE "task_assignees" (
    "task_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "task_assignees_pkey" PRIMARY KEY ("task_id","user_id")
);

-- Migrate existing data from tasks.assignee_id to task_assignees
INSERT INTO "task_assignees" ("task_id", "user_id")
SELECT "id", "assignee_id"
FROM "tasks"
WHERE "assignee_id" IS NOT NULL;

-- Add foreign keys
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Drop the old assignee_id column
ALTER TABLE "tasks" DROP COLUMN "assignee_id";
