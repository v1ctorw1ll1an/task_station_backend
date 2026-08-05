import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX, PASSWORD_MIN } from '../../common/limits';

export class ResetPasswordDto {
  @ApiPropertyOptional({ example: 'Maria Costa' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiProperty({ example: 'NovaS3nh@', minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  newPassword: string;

  @ApiProperty({ example: 'NovaS3nh@' })
  @IsString()
  @MaxLength(PASSWORD_MAX)
  confirmPassword: string;
}
