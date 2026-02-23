import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateProjectDto {
  @ApiPropertyOptional({ example: 'Redesign do App v2' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({ example: 'Nova descrição do projeto' })
  @IsOptional()
  @IsString()
  description?: string;
}
