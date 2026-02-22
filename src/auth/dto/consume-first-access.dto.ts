import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ConsumeFirstAccessDto {
  @ApiProperty({ example: 'João Silva' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'minhaSenha123' })
  @IsString()
  @MinLength(8)
  newPassword: string;

  @ApiProperty({ example: 'minhaSenha123' })
  @IsString()
  @IsNotEmpty()
  confirmPassword: string;
}
