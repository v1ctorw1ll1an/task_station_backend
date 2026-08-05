import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { SeatsChoiceDto } from './seats-choice.dto';

/**
 * Assinar o anual no cartão: compra única, até 12× sem juros, paga na página
 * hospedada do Asaas.
 *
 * `installments` deixou de ser "em quantas vezes cobrar" e virou **o teto oferecido**
 * na página do Asaas — quem escolhe o parcelamento agora é o cliente, lá. Opcional:
 * sem ele, oferecemos o máximo que o valor comporta.
 */
export class SubscribeAnnualCardDto extends SeatsChoiceDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 12,
    description: 'Máximo de parcelas a oferecer no checkout (1 a 12)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  installments?: number;
}
