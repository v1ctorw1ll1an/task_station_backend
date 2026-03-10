import { IsOptional, IsUUID } from 'class-validator';

export class MoveTaskDto {
  @IsUUID('4', { message: 'ID da coluna inválido' })
  columnId: string;

  @IsOptional()
  @IsUUID('4', { message: 'ID da task de referência inválido' })
  afterTaskId?: string | null;
}
