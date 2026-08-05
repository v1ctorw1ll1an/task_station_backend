import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX, PASSWORD_MIN } from '../../common/limits';

export class UpdatePasswordDto {
  @ApiProperty({ description: 'Senha atual' })
  @IsString()
  @MaxLength(PASSWORD_MAX)
  currentPassword: string;

  @ApiProperty({ description: `Nova senha (mínimo ${PASSWORD_MIN} caracteres)` })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  newPassword: string;
}
