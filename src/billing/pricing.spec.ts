import {
  ANNUAL_SEAT_CENTS,
  annualCardTotalCents,
  annualSeatChargeCents,
  annualSeatValueReais,
  annualTotalCents,
  annualValueReais,
  entitledSeats,
  installmentPreview,
  installmentTotalCents,
  maxAnnualInstallments,
  MIN_INSTALLMENT_CENTS,
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

  // ── Parcelamento (só o plano anual no cartão) ──────────────────────────────

  describe('installmentTotalCents', () => {
    it('é a mesma conta que o anual no cartão usa (uma fórmula só)', () => {
      expect(installmentTotalCents(annualTotalCents(1), 12)).toBe(annualCardTotalCents(1, 12));
      expect(installmentTotalCents(annualTotalCents(3), 5)).toBe(annualCardTotalCents(3, 5));
    });

    it('à vista não tem juros', () => {
      expect(installmentTotalCents(21492, 1)).toBe(21492);
    });

    it('parcelar não encarece com a taxa padrão (R36/R45)', () => {
      // A regra da casa: 12× custa o mesmo que à vista. A fórmula de juros continua
      // existindo porque a taxa é configurável por env — mas o padrão é zero.
      for (const n of [2, 6, 12]) {
        expect(installmentTotalCents(21492, n)).toBe(21492);
      }
    });
  });

  describe('maxAnnualInstallments', () => {
    it('o anual de 1 assento cabe nas 12 parcelas cheias', () => {
      expect(maxAnnualInstallments(annualTotalCents(1))).toBe(12);
    });

    it('cai sozinho quando a parcela ficaria abaixo do piso do Asaas', () => {
      // R$19,90 só cabe em 3× de R$6,63.
      expect(maxAnnualInstallments(1990)).toBe(3);
      expect(1990 / 3).toBeGreaterThanOrEqual(MIN_INSTALLMENT_CENTS);
    });

    it('nunca devolve 0 — à vista sempre cabe', () => {
      expect(maxAnnualInstallments(100)).toBe(1);
      expect(maxAnnualInstallments(0)).toBe(1);
    });
  });

  describe('annualCardTotalCents', () => {
    it('com 1 parcela é igual ao anual à vista', () => {
      expect(annualCardTotalCents(1, 1)).toBe(annualTotalCents(1));
    });

    it('em 12× custa o mesmo que à vista (R36)', () => {
      expect(annualCardTotalCents(1, 12)).toBe(annualTotalCents(1)); // R$449,10
      expect(annualCardTotalCents(1, 6)).toBe(annualTotalCents(1));
    });

    it('respeita uma taxa customizada, se a política voltar a cobrar juros', () => {
      // 44910 × (1 + 0,0199 × 12) = 55635 (arredondado)
      expect(annualCardTotalCents(1, 12, 0.0199)).toBe(55635);
      expect(annualCardTotalCents(1, 6, 0.0199)).toBeGreaterThan(annualTotalCents(1));
    });

    it('rejeita número de parcelas fora de 1..12', () => {
      expect(() => annualCardTotalCents(1, 0)).toThrow(RangeError);
      expect(() => annualCardTotalCents(1, 13)).toThrow(RangeError);
    });
  });

  describe('installmentPreview', () => {
    it('ajusta o resto na última parcela (como o Asaas)', () => {
      // Anual de 1 assento em 12×: 44910 não divide certo.
      const { installmentCents, lastInstallmentCents } = installmentPreview(44910, 12);
      expect(installmentCents).toBe(3742); // floor(44910 / 12)
      expect(lastInstallmentCents).toBe(3748); // 44910 − 3742 × 11
      expect(installmentCents * 11 + lastInstallmentCents).toBe(44910);
    });

    it('divide exatamente quando não há resto', () => {
      const { installmentCents, lastInstallmentCents } = installmentPreview(1200, 3);
      expect(installmentCents).toBe(400);
      expect(lastInstallmentCents).toBe(400);
    });
  });

  // ── Trava de regressão: proração não pode voltar de fininho ────────────────

  describe('ausência de proração', () => {
    it('o módulo não exporta mais nenhuma função de proração', () => {
      const exportados = Object.keys(jest.requireActual<Record<string, unknown>>('./pricing'));
      expect(exportados.filter((n) => /proration|proracao/i.test(n))).toEqual([]);
    });

    it('o preço do assento não muda com a data da compra', () => {
      // A regra inteira em uma linha: comprar dia 1 ou dia 28 custa o mesmo.
      expect(monthlySeatChargeCents(2)).toBe(3980);
      expect(annualSeatChargeCents(2)).toBe(35820);
    });
  });
});
