export class NotificationResponseDto {
  id: string;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
  taskId: string | null;
  projectId: string | null;
  actorId: string | null;
  actor: { id: string; name: string } | null;
}
