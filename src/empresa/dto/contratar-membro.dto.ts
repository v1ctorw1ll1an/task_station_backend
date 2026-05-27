import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ContratarMembroDto {
  @IsString()
  @MinLength(2, { message: 'Nome deve ter ao menos 2 caracteres' })
  @MaxLength(100)
  name: string;

  @IsEmail({}, { message: 'Email inválido' })
  email: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(20)
  phone?: string;
}
