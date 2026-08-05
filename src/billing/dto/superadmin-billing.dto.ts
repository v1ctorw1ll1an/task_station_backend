import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SubscriptionStatus } from '../../generated/prisma/client';

export class ListSubscriptionsQueryDto {
  @ApiPropertyOptional({ description: 'Busca por razão social ou CNPJ da empresa' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: SubscriptionStatus })
  @IsOptional()
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class ListWebhooksQueryDto {
  @ApiPropertyOptional({ description: 'Filtrar por status (received|processed|ignored|failed)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @ApiPropertyOptional({ description: 'Filtrar por tipo do evento (contém)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  type?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 100 })
  @IsOptional()
  @Transform(({ value }: { value: string }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 30;
}

export class AdjustSeatsDto {
  @ApiProperty({ minimum: 1, description: 'Novo total de assentos comprados' })
  @IsInt()
  @Min(1)
  @Max(1000)
  total: number;

  /**
   * Aumentar assentos gera cobrança de proração em Pix, como no self-service. Marque
   * `cortesia` para conceder o assento **sem cobrar** (correção manual, acordo
   * comercial) — a isenção fica registrada no log com o motivo.
   */
  @ApiPropertyOptional({ description: 'Conceder os assentos sem cobrança' })
  @IsOptional()
  @IsBoolean()
  cortesia?: boolean;

  @ApiPropertyOptional({ description: 'Por que a isenção foi concedida (obrigatório na cortesia)' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  motivo?: string;
}

export class CourtesyDto {
  @ApiProperty({
    description: 'true = conceder cortesia (isenta); false = revogar (→ somente leitura)',
  })
  @IsBoolean()
  grant: boolean;
}

export class ExtendTrialDto {
  @ApiProperty({ description: 'Nova data de fim do trial (ISO 8601)' })
  @IsISO8601()
  endsAt: string;
}

export class CancelSubscriptionDto {
  @ApiPropertyOptional({
    default: true,
    description: 'true = cancela no fim do ciclo pago; false = cancela imediatamente',
  })
  @IsOptional()
  @IsBoolean()
  atPeriodEnd?: boolean = true;
}

export class SuspendAccessDto {
  @ApiProperty({ description: 'true suspende o acesso; false devolve' })
  @IsBoolean()
  suspended: boolean;

  @ApiPropertyOptional({ description: 'Por que a empresa está sendo suspensa' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  motivo?: string;
}

export class SetReadonlyDto {
  @ApiProperty({ description: 'true = força somente leitura; false = libera o bloqueio manual' })
  @IsBoolean()
  locked: boolean;
}
