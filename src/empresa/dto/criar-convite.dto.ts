import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, MaxLength } from 'class-validator';
import { MembershipRole } from '../../generated/prisma/client';

/**
 * Convite para alguém entrar na empresa. Só `member` e `admin` são convidáveis:
 * papéis de workspace/projeto dependem de um recurso que o convite não conhece e
 * são atribuídos depois, pela tela de membros.
 */
export class CriarConviteDto {
  @ApiProperty({ example: 'maria@acme.com', description: 'E-mail de quem vai ser convidado' })
  @IsEmail({}, { message: 'Email inválido' })
  @MaxLength(254)
  email: string;

  @ApiProperty({ enum: [MembershipRole.member, MembershipRole.admin], required: false })
  @IsOptional()
  @IsIn([MembershipRole.member, MembershipRole.admin], { message: 'Papel inválido' })
  role?: MembershipRole;
}
