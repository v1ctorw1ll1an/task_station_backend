import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX, PASSWORD_MIN } from '../../common/limits';

/**
 * Perfil do superusuário — inclui e-mail e senha, que o `UpdateProfileDto` de
 * `me/` não tem. O nome precisa ser único no processo: o Swagger indexa DTO por
 * nome de classe e dois `UpdateProfileDto` com schemas diferentes colidem
 * (hoje um warning, erro no próximo major do @nestjs/swagger).
 */
export class SuperadminUpdateProfileDto {
  @ApiPropertyOptional({ description: 'Nome completo' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Email (deve ser único)' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ description: 'Telefone' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: `Nova senha (mínimo ${PASSWORD_MIN} caracteres)` })
  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  password?: string;
}
