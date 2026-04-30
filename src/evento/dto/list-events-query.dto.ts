import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class ListEventsQueryDto {
  @IsDateString()
  from: string;

  @IsDateString()
  to: string;

  @IsOptional()
  @IsUUID('4')
  companyId?: string;

  @IsOptional()
  @IsUUID('4')
  workspaceId?: string;
}
