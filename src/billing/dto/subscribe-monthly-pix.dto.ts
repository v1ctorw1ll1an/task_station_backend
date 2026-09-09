import { SeatsChoiceDto } from './seats-choice.dto';

/**
 * Assinar mensal via Pix. Como o anual no Pix, o corpo só carrega a quantidade de
 * assentos — não há cartão. O Asaas emite um Pix novo a cada mês; o cliente paga o QR.
 */
export class SubscribeMonthlyPixDto extends SeatsChoiceDto {}
