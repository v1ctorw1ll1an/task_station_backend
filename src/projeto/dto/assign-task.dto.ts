import { IsOptional, IsUUID } from 'class-validator';

export class AssignTaskDto {
  @IsOptional()
  @IsUUID('4', { message: 'ID do responsável inválido' })
  assigneeId?: string | null;
}
