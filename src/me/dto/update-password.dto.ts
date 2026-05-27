import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdatePasswordDto {
  @ApiProperty({ description: 'Senha atual' })
  @IsString()
  @MaxLength(72)
  currentPassword: string;

  @ApiProperty({ description: 'Nova senha (mínimo 8 caracteres)' })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword: string;
}
