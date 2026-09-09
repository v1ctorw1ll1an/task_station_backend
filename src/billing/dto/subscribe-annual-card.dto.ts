import { SeatsChoiceDto } from './seats-choice.dto';

/**
 * Assinar o anual no cartão: pagamento único por ano, na página hospedada do Asaas,
 * com renovação automática.
 *
 * Não há mais nada a escolher além da quantidade de assentos — o parcelamento em até
 * 12× saiu do produto, e foi o que permitiu o anual virar assinatura recorrente (o
 * Asaas não combina parcelamento com assinatura).
 */
export class SubscribeAnnualCardDto extends SeatsChoiceDto {}
