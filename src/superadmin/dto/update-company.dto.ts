import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateCompanyDto {
  @ApiPropertyOptional({ example: 'Acme S.A.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  legalName?: string;

  @ApiPropertyOptional({ example: '98765432000100' })
  @IsOptional()
  @IsString()
  @MinLength(11)
  @MaxLength(18)
  taxId?: string;
}
