import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateUserDto {
  @ApiPropertyOptional({ description: 'Ativar ou inativar o usuário' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
