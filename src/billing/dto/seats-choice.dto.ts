import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_SEATS } from '../pricing';

/**
 * Quantidade de assentos escolhida na contratação. Opcional por compatibilidade:
 * quem não manda continua contratando o total que a empresa já tem (o `1` do
 * trial, no caso comum).
 *
 * Só vale na PRIMEIRA contratação e nas recontratações (trial/readonly/canceled).
 * Com plano vigente, mexer em assento tem proração e passa por
 * `/assentos/comprar` — o service recusa o campo nesse caso.
 */
export class SeatsChoiceDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_SEATS,
    description: 'Total de assentos a contratar (inclui o assento da base)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_SEATS)
  seats?: number;
}
