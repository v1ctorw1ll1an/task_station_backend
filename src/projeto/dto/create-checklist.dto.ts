import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { FREE } from '../../common/limits';

export class CreateChecklistDto {
  @ApiProperty({ description: 'Título do item do checklist' })
  @IsString()
  @MinLength(1, { message: 'Título não pode ser vazio' })
  @MaxLength(FREE.checklistItem)
  title: string;
}
