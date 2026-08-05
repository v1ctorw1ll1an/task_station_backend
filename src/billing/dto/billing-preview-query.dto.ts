import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export enum PreviewMethod {
  monthly = 'monthly',
  annual_pix = 'annual_pix',
  annual_card = 'annual_card',
}

/** Simulação de preço para o checkout (não cobra nada). */
export class BillingPreviewQueryDto {
  @ApiProperty({ minimum: 1, description: 'Total de assentos comprados a simular' })
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  @Min(1)
  @Max(1000)
  seats: number;

  @ApiProperty({ enum: PreviewMethod })
  @IsEnum(PreviewMethod)
  method: PreviewMethod;

  @ApiPropertyOptional({ minimum: 1, maximum: 12, description: 'Parcelas (só annual_card)' })
  @IsOptional()
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  @Min(1)
  @Max(12)
  installments?: number;
}
