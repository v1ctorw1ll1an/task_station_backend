import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { IsCep, IsCpfCnpj, IsTelefoneBr } from '../../common/validators/is-cpf-cnpj.validator';

/**
 * Perfil de cobrança da empresa — quem paga, onde e com que documento.
 *
 * Deixou de ser "o endereço que o titular do cartão informou de passagem" e virou
 * pré-requisito do pagamento: como o cartão agora é digitado na página do Asaas, é
 * daqui que sai o cadastro do cliente que a página vai exibir. Sem isso completo, o
 * checkout não abre (`BILLING_PROFILE_INCOMPLETE`).
 *
 * Nenhum campo de cartão passa por aqui — nem por lugar nenhum do backend.
 */
export class UpdateBillingAddressDto {
  /**
   * Dados fiscais da empresa. Opcionais: a tela manda quando o admin corrige o
   * cadastro. Vivem na `Company` (não na assinatura) e são o que sai na nota, por
   * isso alterá-los sincroniza o cliente no provedor de pagamento.
   */
  @ApiPropertyOptional({ description: 'Razão social da empresa' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  legalName?: string;

  @ApiPropertyOptional({ description: 'CNPJ ou CPF da empresa (com ou sem máscara)' })
  @IsOptional()
  @IsString()
  @Length(11, 18)
  @IsCpfCnpj()
  taxId?: string;

  @ApiProperty({ description: 'Nome do titular da cobrança' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty()
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ description: 'CPF ou CNPJ (com ou sem máscara)' })
  @IsString()
  @Length(11, 18)
  @IsCpfCnpj()
  cpfCnpj: string;

  @ApiProperty({ description: 'CEP (com ou sem máscara)' })
  @IsString()
  @Length(8, 9)
  @IsCep()
  postalCode: string;

  @ApiProperty({ description: 'Logradouro (rua, avenida…)' })
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  street: string;

  @ApiProperty()
  @IsString()
  @MaxLength(10)
  addressNumber: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  addressComplement?: string;

  @ApiProperty({ description: 'Bairro' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  neighborhood: string;

  @ApiProperty({ description: 'Cidade' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  city: string;

  @ApiProperty({ description: 'UF com 2 letras', example: 'SP' })
  @IsString()
  @Length(2, 2)
  state: string;

  @ApiProperty({ description: 'Telefone com DDD (com ou sem máscara)' })
  @IsString()
  @MinLength(8)
  @MaxLength(20)
  @IsTelefoneBr()
  phone: string;
}
