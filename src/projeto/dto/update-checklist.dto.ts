import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { FREE } from '../../common/limits';

export class UpdateChecklistDto {
  @ApiPropertyOptional({ description: 'Novo título do item' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(FREE.checklistItem)
  title?: string;

  @ApiPropertyOptional({ description: 'Status de conclusão' })
  @IsOptional()
  @IsBoolean()
  completed?: boolean;
}
