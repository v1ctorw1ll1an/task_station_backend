import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { IsCpfCnpj, IsTelefoneBr } from '../../common/validators/is-cpf-cnpj.validator';

/**
 * Auto-cadastro público de empresa (self-service). O registrante É o dono
 * (admin) da empresa e não define senha aqui — recebe um magic link de
 * primeiro acesso por e-mail para ativar a conta.
 */
export class RegisterDto {
  @ApiProperty({ example: 'Acme Ltda', description: 'Razão social da empresa' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  legalName: string;

  @ApiProperty({ example: '12345678000199', description: 'CNPJ ou CPF (com ou sem máscara)' })
  @IsString()
  @MinLength(11)
  @MaxLength(18)
  @IsCpfCnpj()
  taxId: string;

  @ApiProperty({ example: 'João Silva', description: 'Nome do dono da empresa' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  ownerName: string;

  @ApiProperty({ example: 'joao@acme.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: '(11) 98765-4321', description: 'Telefone com DDD (com ou sem máscara)' })
  @IsString()
  @MaxLength(20)
  @IsTelefoneBr()
  phone: string;
}
