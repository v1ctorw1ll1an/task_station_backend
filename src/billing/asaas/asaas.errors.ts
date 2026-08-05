import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Falha do Asaas que é **problema da nossa conta**, não do cliente.
 *
 * Exemplo real (04/08/2026): tentar abrir um checkout com a conta do sandbox sem
 * aprovação cadastral devolve `400 invalid_object — "A criação do checkout está
 * desabilitada. Regularize a situação cadastral."`. Repassar isso adiante fazia o
 * admin da empresa ler, na tela de pagamento dele, uma cobrança sobre a situação
 * cadastral **da TaskDY** — como se ele tivesse feito algo errado, e sem nada que
 * ele pudesse fazer a respeito.
 *
 * Vira 503: é indisponibilidade nossa, o cliente pode tentar de novo depois, e o
 * `AllExceptionsFilter` registra 5xx como erro (4xx vira só warn).
 */
export class AsaasAccountError extends ServiceUnavailableException {
  constructor(readonly providerMessage: string) {
    super({
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
      message:
        'Não foi possível iniciar o pagamento agora. O problema é do nosso lado e a equipe já foi avisada — tente de novo em alguns minutos ou use outra forma de pagamento.',
    });
  }
}

/**
 * Assinaturas de mensagem que indicam conta/recurso bloqueado do **nosso** lado.
 *
 * A lista é curta e literal de propósito: o `code` do Asaas não distingue (o mesmo
 * `invalid_object` cobre "faltou o campo items" e "checkout desabilitado"), então a
 * classificação sai do texto. Errar para o lado de mais casos esconderia erros que o
 * cliente **consegue** corrigir ("CPF inválido") atrás de um "tente mais tarde"; por
 * isso, o que não casar aqui continua sendo devolvido como 400 com a mensagem do
 * provedor. Cresce conforme aparecerem casos novos.
 *
 * Recusa de cartão não entra na conta: com o checkout hospedado, o cartão é digitado
 * na página do Asaas e a recusa nem chega à nossa API.
 */
const SINAIS_DE_CONTA: RegExp[] = [
  // "Regularize a situação cadastral."
  /situa[çc][ãa]o cadastral/i,
  // "A criação do checkout está desabilitada", "Pix está desabilitado nesta conta"
  /(est[áa]|encontra-se)\s+(desabilitad|indisponív|bloquead)/i,
  // "Sua conta não está habilitada para ..."
  /n[ãa]o (est[áa] )?habilitad/i,
  // "Conta em análise", "conta bloqueada", "conta suspensa"
  /\bconta\b.{0,40}\b(em an[áa]lise|bloqueada|suspensa|n[ãa]o aprovada)\b/i,
];

/** `true` quando a mensagem do provedor é sobre a nossa conta, não sobre o cliente. */
export function ehProblemaDaNossaConta(description: string | undefined): boolean {
  if (!description) return false;
  return SINAIS_DE_CONTA.some((re) => re.test(description));
}
