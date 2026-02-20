import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'admin@taskstation.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'Admin@123456', minLength: 6 })
  @IsString()
  @MinLength(6)
  password: string;
}
