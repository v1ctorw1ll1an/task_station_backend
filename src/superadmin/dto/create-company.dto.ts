import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class CreateCompanyDto {
  @ApiProperty({ example: 'Acme Ltda' })
  @IsString()
  @IsNotEmpty()
  legalName: string;

  @ApiProperty({ example: '12345678000199', description: 'CNPJ (somente números)' })
  @IsString()
  @IsNotEmpty()
  taxId: string;

  @ApiProperty({ example: 'João Silva' })
  @IsString()
  @IsNotEmpty()
  adminName: string;

  @ApiProperty({ example: 'admin@acme.com' })
  @IsEmail()
  adminEmail: string;
}
