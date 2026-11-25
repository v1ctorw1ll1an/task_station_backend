import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { API_TOKEN } from '../../common/limits';

export class CreateApiTokenDto {
  @ApiProperty({ description: 'Nome para reconhecer o token', example: 'Claude Code no notebook' })
  @IsString()
  @MinLength(1, { message: 'Nome é obrigatório' })
  @MaxLength(API_TOKEN.nameMax)
  name!: string;

  @ApiProperty({ description: 'Workspace ao qual o token fica restrito' })
  @IsUUID('4', { message: 'ID do workspace inválido' })
  workspaceId!: string;

  @ApiPropertyOptional({
    description: 'Validade em dias',
    default: API_TOKEN.defaultDays,
    minimum: 1,
    maximum: API_TOKEN.maxDays,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(API_TOKEN.maxDays)
  expiresInDays?: number;
}
