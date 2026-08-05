import { isValidCnpj, isValidCpf, isValidTaxId, normalizeTaxId } from './tax-id';

/**
 * Trava do que fazia o pagamento falhar: documento inválido passava batido pelo
 * formulário e só era recusado pelo Asaas, depois de o cliente digitar o cartão.
 */
describe('tax-id', () => {
  describe('normalizeTaxId', () => {
    it('mantém só os dígitos', () => {
      expect(normalizeTaxId('12.345.678/0001-99')).toBe('12345678000199');
      expect(normalizeTaxId('123.456.789-09')).toBe('12345678909');
    });
  });

  describe('CPF', () => {
    it.each(['12345678909', '52998224725', '111.444.777-35'])('aceita %s', (cpf) => {
      expect(isValidTaxId(cpf)).toBe(true);
    });

    it('recusa dígito verificador errado', () => {
      expect(isValidCpf('12345678900')).toBe(false);
      expect(isValidCpf('52998224724')).toBe(false);
    });

    it('recusa sequência repetida (o erro de digitação mais comum)', () => {
      for (const d of '0123456789') {
        expect(isValidCpf(d.repeat(11))).toBe(false);
      }
    });

    it('recusa tamanho errado', () => {
      expect(isValidCpf('1234567890')).toBe(false);
      expect(isValidCpf('123456789012')).toBe(false);
    });
  });

  describe('CNPJ', () => {
    it.each(['11222333000181', '11.222.333/0001-81'])('aceita %s', (cnpj) => {
      expect(isValidTaxId(cnpj)).toBe(true);
    });

    it('recusa dígito verificador errado', () => {
      expect(isValidCnpj('11222333000180')).toBe(false);
      // O CNPJ que usei num teste manual e o Asaas recusou — a razão de tudo isto.
      expect(isValidCnpj('55443322000177')).toBe(false);
    });

    it('recusa sequência repetida', () => {
      expect(isValidCnpj('11111111111111')).toBe(false);
      expect(isValidCnpj('00000000000000')).toBe(false);
    });
  });

  describe('isValidTaxId', () => {
    it('recusa qualquer coisa que não tenha 11 ou 14 dígitos', () => {
      expect(isValidTaxId('')).toBe(false);
      expect(isValidTaxId('123')).toBe(false);
      expect(isValidTaxId('1234567890123')).toBe(false);
      expect(isValidTaxId('abc.def.ghi-jk')).toBe(false);
    });
  });
});
