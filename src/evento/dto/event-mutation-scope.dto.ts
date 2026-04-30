import { IsDateString, IsEnum, IsOptional } from 'class-validator';

export enum EventMutationScope {
  single = 'single',
  future = 'future',
  all = 'all',
}

export class EventMutationScopeDto {
  @IsOptional()
  @IsEnum(EventMutationScope)
  scope?: EventMutationScope;

  // ISO datetime da ocorrência original. Obrigatório para scope=single|future.
  @IsOptional()
  @IsDateString()
  originalDate?: string;
}
