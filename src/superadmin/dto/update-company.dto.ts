import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateCompanyDto {
  @ApiPropertyOptional({ example: 'Acme S.A.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  legalName?: string;

  @ApiPropertyOptional({ example: '98765432000100' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  taxId?: string;
}
