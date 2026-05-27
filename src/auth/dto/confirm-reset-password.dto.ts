import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ConfirmResetPasswordDto {
  @ApiProperty({ example: 'NovaS3nh@', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword: string;

  @ApiProperty({ example: 'NovaS3nh@' })
  @IsString()
  @MaxLength(72)
  confirmPassword: string;
}
