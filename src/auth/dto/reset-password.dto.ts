import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ example: 'NovaS3nh@', minLength: 6 })
  @IsString()
  @MinLength(6)
  newPassword: string;

  @ApiProperty({ example: 'NovaS3nh@' })
  @IsString()
  confirmPassword: string;
}
