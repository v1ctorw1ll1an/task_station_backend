export type KanbanEvent =
  | 'task:created'
  | 'task:updated'
  | 'task:moved'
  | 'task:deleted'
  | 'task:restored'
  | 'column:created'
  | 'column:updated'
  | 'column:reordered'
  | 'column:deleted';

export interface KanbanTaskSnapshot {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  order: number;
  dueDate: Date | null;
  startDate: Date | null;
  updatedAt: Date;
  columnId: string;
  projectId: string;
  taskAssignees: { user: { id: string; name: string; email: string; photoUrl: string | null } }[];
  reporter: { id: string; name: string; email: string; photoUrl: string | null };
  taskLabels: { label: { id: string; name: string; color: string } }[];
}

export interface ColumnSnapshot {
  id: string;
  name: string;
  color: string | null;
  order: number;
  tasks: KanbanTaskSnapshot[];
}

// ── Payload por evento ────────────────────────────────────────────────────────

export interface TaskCreatedPayload {
  task: KanbanTaskSnapshot;
  columnId: string;
}

export interface TaskUpdatedPayload {
  task: KanbanTaskSnapshot;
  actorId: string;
}

export interface TaskMovedPayload {
  taskId: string;
  fromColumnId: string;
  toColumnId: string;
  afterTaskId: string | null;
  actorId: string;
}

export interface TaskDeletedPayload {
  taskId: string;
  columnId: string;
  actorId: string;
}

export interface TaskRestoredPayload {
  task: KanbanTaskSnapshot;
  columnId: string;
}

export interface ColumnCreatedPayload {
  column: ColumnSnapshot;
}

export interface ColumnUpdatedPayload {
  columnId: string;
  changes: { name?: string; color?: string | null };
}

export interface ColumnReorderedPayload {
  orderedColumnIds: string[];
}

export interface ColumnDeletedPayload {
  columnId: string;
  targetColumnId: string | null;
  movedTaskIds: string[];
}

// Tipo discriminado para uso interno no service
export type KanbanEventPayload =
  | { event: 'task:created'; data: TaskCreatedPayload }
  | { event: 'task:updated'; data: TaskUpdatedPayload }
  | { event: 'task:moved'; data: TaskMovedPayload }
  | { event: 'task:deleted'; data: TaskDeletedPayload }
  | { event: 'task:restored'; data: TaskRestoredPayload }
  | { event: 'column:created'; data: ColumnCreatedPayload }
  | { event: 'column:updated'; data: ColumnUpdatedPayload }
  | { event: 'column:reordered'; data: ColumnReorderedPayload }
  | { event: 'column:deleted'; data: ColumnDeletedPayload };
