import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateCompanyDto {
  @ApiProperty({ example: 'Acme Ltda' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  legalName: string;

  @ApiProperty({ example: '12345678000199', description: 'CNPJ (somente números)' })
  @IsString()
  @MinLength(11)
  @MaxLength(18)
  taxId: string;

  @ApiPropertyOptional({
    example: 'João Silva',
    description: 'Ignorado se o email já pertence a um usuário existente',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  adminName?: string;

  @ApiProperty({ example: 'admin@acme.com' })
  @IsEmail()
  @MaxLength(254)
  adminEmail: string;
}
