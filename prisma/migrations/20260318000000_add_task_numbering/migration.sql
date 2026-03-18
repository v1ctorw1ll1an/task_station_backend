-- Add task_counter to projects
ALTER TABLE "projects" ADD COLUMN "task_counter" INTEGER NOT NULL DEFAULT 0;

-- Add task_number to tasks
ALTER TABLE "tasks" ADD COLUMN "task_number" INTEGER;

-- Add unique index on (project_id, task_number)
CREATE UNIQUE INDEX "tasks_project_id_task_number_key" ON "tasks"("project_id", "task_number");
