import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class BuySeatsDto {
  @ApiProperty({ minimum: 1, maximum: 999, description: 'Quantidade de assentos a comprar' })
  @IsInt()
  @Min(1)
  @Max(999)
  quantity: number;

  /**
   * Como o cliente quer pagar esta compra — vale nos dois planos. No cartão, a
   * resposta traz o link do checkout hospedado; no Pix, o QR aparece no painel.
   * Padrão: cartão.
   */
  @ApiPropertyOptional({
    enum: ['pix', 'credit_card'],
    description: 'Forma de pagamento da compra de assentos',
  })
  @IsOptional()
  @IsIn(['pix', 'credit_card'])
  paymentKind?: 'pix' | 'credit_card';
}

export class ReduceSeatsDto {
  @ApiProperty({ minimum: 1, maximum: 999, description: 'Quantidade de assentos a remover' })
  @IsInt()
  @Min(1)
  @Max(999)
  quantity: number;

  /**
   * Quem perde o acesso quando a redução valer. Obrigatório quando a redução mexe
   * em assentos ocupados — sem isso não há como saber quem sai. Assentos vagos são
   * devolvidos sem tocar em ninguém, então a lista pode vir vazia.
   */
  @ApiPropertyOptional({
    type: [String],
    description: 'IDs dos usuários que sairão na próxima renovação',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  userIds?: string[];
}

export class SeatPreviewQueryDto {
  @ApiProperty({ minimum: 1, maximum: 999 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  quantity: number;

  @ApiProperty({ enum: ['comprar', 'reduzir'] })
  @IsIn(['comprar', 'reduzir'])
  acao: 'comprar' | 'reduzir';

  /**
   * Forma de pagamento simulada. Não muda o preço (parcelar não encarece e não há
   * proração), mas muda o texto: no Pix o assento libera assim que o QR é pago; no
   * cartão, quando o Asaas confirmar.
   */
  @ApiPropertyOptional({ enum: ['pix', 'credit_card'] })
  @IsOptional()
  @IsIn(['pix', 'credit_card'])
  pagamento?: 'pix' | 'credit_card';
}
