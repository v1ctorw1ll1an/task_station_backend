import { SeatsChoiceDto } from './seats-choice.dto';

/**
 * Assinar anual via Pix. O corpo só carrega a quantidade de assentos — não há
 * cartão nem parcelas. Corpo ausente continua válido (todos os campos opcionais),
 * então clientes antigos que faziam POST sem body seguem funcionando.
 */
export class SubscribeAnnualPixDto extends SeatsChoiceDto {}
