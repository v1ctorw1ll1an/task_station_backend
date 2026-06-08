import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { FREE } from '../../common/limits';
import { TaskPriority } from '../../generated/prisma/client';

export class CreateTaskDto {
  @IsString()
  @MinLength(1, { message: 'Título é obrigatório' })
  @MaxLength(FREE.taskTitle)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(FREE.taskDescription)
  description?: string;

  @IsUUID('4', { message: 'ID da coluna inválido' })
  columnId: string;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true, message: 'ID do responsável inválido' })
  assigneeIds?: string[];

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsBoolean()
  allDay?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  labelIds?: string[];
}
