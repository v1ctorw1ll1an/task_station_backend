import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { FREE } from '../../common/limits';
import { TaskPriority } from '../../generated/prisma/client';

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(FREE.taskTitle)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(FREE.taskDescription)
  description?: string;

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
  startDate?: string | null;

  @IsOptional()
  @IsDateString()
  dueDate?: string | null;

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

  /** ISO timestamp do último updatedAt conhecido pelo cliente — usado para detecção de conflito */
  @IsOptional()
  @IsISO8601()
  lastKnownUpdatedAt?: string;
}
