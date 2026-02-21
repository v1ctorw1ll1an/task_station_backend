import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateWorkspaceDto {
  @ApiProperty({ example: 'Desenvolvimento' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Workspace de desenvolvimento de produtos' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 'Maria Costa' })
  @IsString()
  @IsNotEmpty()
  adminName: string;

  @ApiProperty({ example: 'maria@acme.com' })
  @IsEmail()
  adminEmail: string;
}
