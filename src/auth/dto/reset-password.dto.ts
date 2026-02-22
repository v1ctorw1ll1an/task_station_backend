import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiPropertyOptional({ example: 'Maria Costa' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ example: 'NovaS3nh@', minLength: 6 })
  @IsString()
  @MinLength(6)
  newPassword: string;

  @ApiProperty({ example: 'NovaS3nh@' })
  @IsString()
  confirmPassword: string;
}
