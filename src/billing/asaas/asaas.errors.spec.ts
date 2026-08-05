import { AsaasAccountError, ehProblemaDaNossaConta } from './asaas.errors';

/**
 * A classificação separa "problema nosso" de "problema do cliente" pelo **texto** da
 * mensagem — o Asaas usa o mesmo `code` (`invalid_object`) para os dois. Errar aqui
 * tem dois custos opostos, e os dois estão travados abaixo:
 *
 * - classificar de menos → o cliente lê "regularize a situação cadastral" (nossa) e
 *   acha que fez algo errado;
 * - classificar de mais → o cliente lê "tente mais tarde" quando o CPF dele é que
 *   estava inválido, e nunca descobre o que corrigir.
 */
describe('classificação de erro do Asaas', () => {
  describe('é problema da NOSSA conta', () => {
    // Mensagem real, capturada do sandbox em 04/08/2026.
    it('reconhece "regularize a situação cadastral"', () => {
      expect(
        ehProblemaDaNossaConta(
          'A criação do checkout está desabilitada. Regularize a situação cadastral.',
        ),
      ).toBe(true);
    });

    it.each([
      'A criação do checkout está desabilitada.',
      'O Pix está desabilitado para esta conta.',
      'Este recurso encontra-se indisponível.',
      'Sua conta não está habilitada para emitir cobranças no cartão.',
      'Conta em análise. Aguarde a aprovação para utilizar este recurso.',
      'A conta está bloqueada.',
    ])('reconhece "%s"', (msg) => {
      expect(ehProblemaDaNossaConta(msg)).toBe(true);
    });
  });

  describe('é problema do CLIENTE (a mensagem tem de chegar até ele)', () => {
    it.each([
      'CPF ou CNPJ inválido.',
      'O campo items é obrigatório.',
      'Transação não autorizada. Entre em contato com a operadora do seu cartão.',
      'O valor da cobrança deve ser maior que zero.',
      'CEP inválido.',
      'A data de vencimento não pode ser anterior a hoje.',
      'Já existe uma assinatura para este cliente.',
    ])('não classifica como nosso: "%s"', (msg) => {
      expect(ehProblemaDaNossaConta(msg)).toBe(false);
    });

    it('mensagem ausente não vira problema de conta', () => {
      expect(ehProblemaDaNossaConta(undefined)).toBe(false);
      expect(ehProblemaDaNossaConta('')).toBe(false);
    });
  });

  describe('AsaasAccountError', () => {
    const erro = new AsaasAccountError('Regularize a situação cadastral.');

    it('é 503 — indisponibilidade nossa, não erro do pedido', () => {
      expect(erro.getStatus()).toBe(503);
    });

    it('NÃO expõe a mensagem do provedor para o cliente', () => {
      const corpo = erro.getResponse() as { code: string; message: string };
      expect(corpo.message).not.toMatch(/cadastral/i);
      expect(corpo.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      // Assume a culpa e oferece saída — o cliente não tem o que corrigir.
      expect(corpo.message).toMatch(/nosso lado/i);
    });

    it('guarda a mensagem original para o log e o alerta', () => {
      expect(erro.providerMessage).toBe('Regularize a situação cadastral.');
    });
  });
});
