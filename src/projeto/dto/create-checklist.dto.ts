import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateChecklistDto {
  @ApiProperty({ description: 'Título do item do checklist' })
  @IsString()
  @MinLength(1, { message: 'Título não pode ser vazio' })
  @MaxLength(500)
  title: string;
}
