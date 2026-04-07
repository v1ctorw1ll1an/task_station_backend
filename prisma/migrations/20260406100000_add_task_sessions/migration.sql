-- CreateTable
CREATE TABLE "task_sessions" (
    "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "task_id"      TEXT NOT NULL,
    "user_id"      TEXT NOT NULL,
    "status"       TEXT NOT NULL DEFAULT 'running',
    "started_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    "resumed_at"   TIMESTAMPTZ,
    "paused_at"    TIMESTAMPTZ,
    "stopped_at"   TIMESTAMPTZ,
    "total_seconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "task_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_sessions_task_id_idx" ON "task_sessions"("task_id");

-- CreateIndex
CREATE INDEX "task_sessions_user_id_status_idx" ON "task_sessions"("user_id", "status");

-- AddForeignKey
ALTER TABLE "task_sessions" ADD CONSTRAINT "task_sessions_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_sessions" ADD CONSTRAINT "task_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
