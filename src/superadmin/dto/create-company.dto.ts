import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateCompanyDto {
  @ApiProperty({ example: 'Acme Ltda' })
  @IsString()
  @IsNotEmpty()
  legalName: string;

  @ApiProperty({ example: '12345678000199', description: 'CNPJ (somente números)' })
  @IsString()
  @IsNotEmpty()
  taxId: string;

  @ApiPropertyOptional({
    example: 'João Silva',
    description: 'Ignorado se o email já pertence a um usuário existente',
  })
  @IsOptional()
  @IsString()
  adminName?: string;

  @ApiProperty({ example: 'admin@acme.com' })
  @IsEmail()
  adminEmail: string;
}
