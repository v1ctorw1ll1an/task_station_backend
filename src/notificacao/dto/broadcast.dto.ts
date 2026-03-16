import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class BroadcastDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  body: string;

  @IsOptional()
  @IsUUID()
  targetUserId?: string;
}
