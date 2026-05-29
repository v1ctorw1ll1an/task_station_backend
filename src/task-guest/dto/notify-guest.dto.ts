import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class NotifyGuestDto {
  @ApiProperty({
    description: 'IDs de entradas de TaskHistory para incluir no relatório',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  historyEntryIds!: string[];

  @ApiPropertyOptional({
    description: 'Texto do resumo editado pelo usuário (substitui o resumo padrão das mudanças)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  message?: string;
}
