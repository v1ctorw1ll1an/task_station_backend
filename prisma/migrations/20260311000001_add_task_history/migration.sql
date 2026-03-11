CREATE TABLE "task_history" (
  "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  "task_id"    TEXT         NOT NULL,
  "user_id"    TEXT         NOT NULL,
  "field"      VARCHAR(50)  NOT NULL,
  "old_value"  TEXT,
  "new_value"  TEXT,
  "changed_at" TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT "task_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_history_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE,
  CONSTRAINT "task_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE INDEX "task_history_task_id_idx"    ON "task_history"("task_id");
CREATE INDEX "task_history_changed_at_idx" ON "task_history"("changed_at" DESC);
