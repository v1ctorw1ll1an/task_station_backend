import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export enum TaskDateFilter {
  TODAY = 'today',
  TOMORROW = 'tomorrow',
  THIS_WEEK = 'this_week',
  OVERDUE = 'overdue',
  CUSTOM = 'custom',
}

export class ListMyTasksQueryDto {
  @ApiProperty({ description: 'ID da empresa (UUID)' })
  @IsUUID()
  companyId: string;

  @ApiPropertyOptional({ enum: TaskDateFilter, description: 'Filtro de período' })
  @IsOptional()
  @IsEnum(TaskDateFilter)
  filter?: TaskDateFilter;

  @ApiPropertyOptional({ description: 'Data inicial (ISO date) — usado quando filter=custom' })
  @IsOptional()
  @IsString()
  dueDateFrom?: string;

  @ApiPropertyOptional({ description: 'Data final (ISO date) — usado quando filter=custom' })
  @IsOptional()
  @IsString()
  dueDateTo?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number = 20;
}
