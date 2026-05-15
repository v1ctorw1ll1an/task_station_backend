import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateGuestDto {
  @ApiProperty({ description: 'Nome do convidado', example: 'João Silva' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    description: 'Telefone em formato internacional (será normalizado para E.164)',
    example: '+5511999999999',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phone!: string;

  @ApiPropertyOptional({ description: 'Email do convidado (opcional)' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}
