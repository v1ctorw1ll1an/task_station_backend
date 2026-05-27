import { IsArray, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { FREE } from '../../common/limits';

export class BroadcastDto {
  @IsString()
  @MinLength(1)
  @MaxLength(FREE.broadcastTitle)
  title: string;

  @IsString()
  @MinLength(1)
  @MaxLength(FREE.broadcastBody)
  body: string;

  @IsOptional()
  @IsUUID()
  targetUserId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  companyIds?: string[];
}

export class CompanyBroadcastDto {
  @IsString()
  @MinLength(1)
  @MaxLength(FREE.broadcastTitle)
  title: string;

  @IsString()
  @MinLength(1)
  @MaxLength(FREE.broadcastBody)
  body: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  workspaceIds?: string[];
}
