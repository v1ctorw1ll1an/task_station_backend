import {
  ANNUAL_SEAT_CENTS,
  annualSeatChargeCents,
  annualSeatValueReais,
  annualTotalCents,
  annualValueReais,
  entitledSeats,
  monthlySeatChargeCents,
  monthlyTotalCents,
  monthlyValueReais,
} from './pricing';

describe('pricing', () => {
  describe('monthlyTotalCents', () => {
    it('cobra os exemplos do documento de regras', () => {
      expect(monthlyTotalCents(1)).toBe(4990); // R$49,90
      expect(monthlyTotalCents(3)).toBe(8970); // R$89,70
      expect(monthlyTotalCents(10)).toBe(22900); // R$229,00
    });

    it('rejeita quantidade de assentos inválida', () => {
      expect(() => monthlyTotalCents(0)).toThrow(RangeError);
      expect(() => monthlyTotalCents(1.5)).toThrow(RangeError);
    });
  });

  describe('annualTotalCents', () => {
    it('é 12× o mensal com 25% de desconto', () => {
      expect(annualTotalCents(1)).toBe(44910); // 59880 × 0,75 = R$449,10
      expect(annualTotalCents(3)).toBe(80730); // 107640 × 0,75
    });
  });

  describe('conversão para reais (borda do Asaas)', () => {
    it('devolve o decimal que a API espera', () => {
      expect(monthlyValueReais(3)).toBe(89.7);
      expect(annualValueReais(1)).toBe(449.1);
      expect(annualSeatValueReais(2)).toBe(358.2);
    });
  });

  // ── Valor cheio: o coração da mudança ──────────────────────────────────────

  describe('monthlySeatChargeCents', () => {
    it('cobra o assento cheio, sem olhar o calendário', () => {
      expect(monthlySeatChargeCents(1)).toBe(1990); // R$19,90
      expect(monthlySeatChargeCents(4)).toBe(7960);
    });

    it('não usa a base do plano — assento adicional é sempre preço de adicional', () => {
      expect(monthlySeatChargeCents(1)).not.toBe(monthlyTotalCents(1));
    });

    it('rejeita quantidade inválida', () => {
      expect(() => monthlySeatChargeCents(0)).toThrow(RangeError);
      expect(() => monthlySeatChargeCents(2.5)).toThrow(RangeError);
    });
  });

  describe('annualSeatChargeCents', () => {
    it('cobra um ano cheio por assento, com o mesmo desconto do plano', () => {
      expect(ANNUAL_SEAT_CENTS).toBe(17910); // 1990 × 12 × 0,75 = R$179,10
      expect(annualSeatChargeCents(1)).toBe(17910);
      expect(annualSeatChargeCents(3)).toBe(53730);
    });

    it('sai mais barato que 12 mensalidades avulsas (o desconto vale para o assento)', () => {
      expect(annualSeatChargeCents(1)).toBeLessThan(monthlySeatChargeCents(1) * 12);
    });

    it('mantém a proporção do plano: assento anual = 12× o mensal com o desconto', () => {
      expect(annualSeatChargeCents(1)).toBe(annualTotalCents(2) - annualTotalCents(1));
    });
  });

  describe('entitledSeats', () => {
    it('soma os assentos do plano com os comprados avulsos no anual', () => {
      expect(entitledSeats({ purchasedSeats: 5, addonSeats: 3 })).toBe(8);
    });

    it('sem add-ons é o próprio plano', () => {
      expect(entitledSeats({ purchasedSeats: 5, addonSeats: 0 })).toBe(5);
    });
  });

  // ── Travas de regressão: o que saiu do produto não volta de fininho ────────

  describe('ausência de proração e de parcelamento', () => {
    it('o módulo não exporta mais nenhuma função de proração', () => {
      const exportados = Object.keys(jest.requireActual<Record<string, unknown>>('./pricing'));
      expect(exportados.filter((n) => /proration|proracao/i.test(n))).toEqual([]);
    });

    it('o módulo não exporta mais nenhuma conta de parcelamento', () => {
      // O anual é pagamento único — e é isso que permite ele ser assinatura no Asaas,
      // que não combina parcelamento com recorrência. Reintroduzir qualquer uma destas
      // funções significa ter desfeito a renovação automática sem perceber.
      const exportados = Object.keys(jest.requireActual<Record<string, unknown>>('./pricing'));
      expect(exportados.filter((n) => /installment|parcel/i.test(n))).toEqual([]);
    });

    it('o preço do assento não muda com a data da compra', () => {
      // A regra inteira em uma linha: comprar dia 1 ou dia 28 custa o mesmo.
      expect(monthlySeatChargeCents(2)).toBe(3980);
      expect(annualSeatChargeCents(2)).toBe(35820);
    });
  });
});
