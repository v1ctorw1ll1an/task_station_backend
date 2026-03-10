import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { TaskPriority } from '../../generated/prisma/client';

export class CreateTaskDto {
  @IsString()
  @MinLength(1, { message: 'Título é obrigatório' })
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsUUID('4', { message: 'ID da coluna inválido' })
  columnId: string;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @IsUUID('4', { message: 'ID do responsável inválido' })
  assigneeId?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;
}
