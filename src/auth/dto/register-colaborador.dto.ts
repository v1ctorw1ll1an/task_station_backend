import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Auto-cadastro público de colaborador (self-service). Diferente do `RegisterDto`,
 * NÃO cria empresa: cria só a conta da pessoa, que depois entra em uma ou mais
 * empresas por convite. Sem senha aqui — recebe um magic link de primeiro acesso.
 */
export class RegisterColaboradorDto {
  @ApiProperty({ example: 'Maria Souza', description: 'Nome do colaborador' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'maria@acme.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;
}
