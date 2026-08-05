import { SeatsChoiceDto } from './seats-choice.dto';

/**
 * Assinar o plano mensal. O corpo só carrega a quantidade de assentos: o cartão é
 * digitado na página hospedada do Asaas, para onde a resposta manda o cliente
 * (`checkoutUrl`). Nenhum dado de cartão entra na API.
 */
export class SubscribeMonthlyDto extends SeatsChoiceDto {}
