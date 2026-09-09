import { readFileSync } from 'fs';
import { join } from 'path';
import type { BillingMethod } from '../generated/prisma/client';
import {
  cycleOf,
  isAnnual,
  isCard,
  isMonthly,
  paymentKindOf,
  traitsOf,
  usesHostedCheckout,
} from './billing-method';

/**
 * Trava do eixo cadência × forma.
 *
 * O bug que este arquivo existe para impedir: enquanto o mensal só existia no cartão,
 * `method === 'monthly_card'` respondia às duas perguntas ("é mensal?" e "é cartão?")
 * por acidente. Quando surgiu um mensal que não é cartão, cada um desses testes virou
 * um erro de dinheiro — assento cobrado como anual, recorrência nunca reajustada,
 * cancelamento que não derruba a cobrança do mês seguinte.
 */
describe('billing-method', () => {
  /** Os valores do enum lidos do SCHEMA, não de uma lista repetida aqui. */
  function metodosDoSchema(): string[] {
    const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
    const bloco = /enum BillingMethod \{([\s\S]*?)\}/.exec(schema);
    if (!bloco) throw new Error('enum BillingMethod não encontrado no schema');
    return bloco[1]
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter((l) => l && !l.startsWith('@@'));
  }

  it('todo método do schema tem traço definido', () => {
    // Se este teste falhar, alguém adicionou uma forma de pagamento e não disse qual é
    // a cadência nem a forma dela. Sem isso, ela cairia calada no `else` de uma dúzia
    // de decisões — e o `else` de todas elas hoje é "anual" ou "cartão".
    for (const metodo of metodosDoSchema()) {
      expect(traitsOf(metodo as BillingMethod)).not.toBeNull();
    }
  });

  it('cadência e forma são eixos independentes — as quatro combinações existem', () => {
    expect(metodosDoSchema().sort()).toEqual(
      ['annual_card', 'annual_pix', 'monthly_card', 'monthly_pix'].sort(),
    );
  });

  it('"é mensal" não é mais sinônimo de "é cartão"', () => {
    // A afirmação central: existe um mensal que não é cartão e um cartão que não é
    // mensal. Qualquer código que use um pelo outro está errado em pelo menos um caso.
    expect(isMonthly('monthly_pix')).toBe(true);
    expect(isCard('monthly_pix')).toBe(false);
    expect(isCard('annual_card')).toBe(true);
    expect(isMonthly('annual_card')).toBe(false);
  });

  it('cadência classifica os quatro métodos', () => {
    expect(['monthly_card', 'monthly_pix'].every((m) => isMonthly(m as BillingMethod))).toBe(true);
    expect(['annual_card', 'annual_pix'].every((m) => isAnnual(m as BillingMethod))).toBe(true);
    expect(['monthly_card', 'monthly_pix'].some((m) => isAnnual(m as BillingMethod))).toBe(false);
  });

  it('paymentKind sai do método, nunca de um ternário na mão', () => {
    expect(paymentKindOf('monthly_pix')).toBe('pix');
    expect(paymentKindOf('annual_pix')).toBe('pix');
    expect(paymentKindOf('monthly_card')).toBe('credit_card');
    expect(paymentKindOf('annual_card')).toBe('credit_card');
  });

  it('ciclo do Asaas acompanha a cadência', () => {
    expect(cycleOf('monthly_pix')).toBe('MONTHLY');
    expect(cycleOf('monthly_card')).toBe('MONTHLY');
    expect(cycleOf('annual_pix')).toBe('YEARLY');
    expect(cycleOf('annual_card')).toBe('YEARLY');
  });

  it('só os planos de cartão nascem do checkout hospedado', () => {
    // É o que decide se o `asaasSubscriptionId` precisa ser descoberto no webhook. Nos
    // planos Pix nós criamos a assinatura pela API e já gravamos o id na contratação —
    // procurá-lo de novo lá poderia adotar a assinatura errada.
    expect(usesHostedCheckout('monthly_card')).toBe(true);
    expect(usesHostedCheckout('annual_card')).toBe(true);
    expect(usesHostedCheckout('monthly_pix')).toBe(false);
    expect(usesHostedCheckout('annual_pix')).toBe(false);
  });

  it('plano ainda não contratado não é nada — nem mensal, nem anual, nem cartão', () => {
    // O trial cai aqui. Quem precisa distinguir "sem plano" de "plano que não é X" tem
    // que checar o nulo antes; responder `true` a qualquer uma destas daria acesso ou
    // cobrança a quem não contratou.
    expect(isMonthly(null)).toBe(false);
    expect(isAnnual(null)).toBe(false);
    expect(isCard(null)).toBe(false);
    expect(usesHostedCheckout(null)).toBe(false);
    expect(traitsOf(null)).toBeNull();
  });
});
