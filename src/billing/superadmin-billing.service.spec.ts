import { NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AsaasClient } from './asaas/asaas.client';
import { BillingAccessService } from './billing-access.service';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { BillingWebhookService } from './billing-webhook.service';
import { SuperadminBillingService } from './superadmin-billing.service';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    companyId: 'c1',
    status: 'active',
    method: 'monthly_card',
    purchasedSeats: 3,
    asaasSubscriptionId: 'asub_1',
    superadminLocked: false,
    ...overrides,
  };
}

function make(sub: Record<string, unknown> | null = makeSub(), occupied = 1) {
  const repo = {
    findSubscriptionByCompany: jest.fn().mockResolvedValue(sub),
    updateSubscription: jest.fn().mockResolvedValue({}),
    countOccupiedSeats: jest.fn().mockResolvedValue(occupied),
    findAllCharges: jest.fn().mockResolvedValue([]),
    getCompanyFiscal: jest.fn().mockResolvedValue({ legalName: 'ACME', taxId: '1' }),
    findSeatAddons: jest.fn().mockResolvedValue([]),
    findSeatAddonById: jest.fn().mockResolvedValue(null),
    updateSeatAddon: jest.fn().mockResolvedValue({}),
    syncAddonSeats: jest.fn().mockResolvedValue(0),
    findWebhookEventById: jest.fn().mockResolvedValue(null),
    listWebhookEvents: jest.fn().mockResolvedValue([[], 0]),
    subscriptionsForRevenue: jest.fn().mockResolvedValue([]),
    sumCharges: jest.fn().mockResolvedValue({ totalCents: 0, count: 0 }),
    sumOpenCharges: jest.fn().mockResolvedValue({ totalCents: 0, count: 0 }),
    findRenewalsBetween: jest.fn().mockResolvedValue([]),
    countTrialsEndingBefore: jest.fn().mockResolvedValue(0),
    countCanceledBetween: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<BillingRepository>;
  const asaas = {
    deleteSubscription: jest.fn().mockResolvedValue({ deleted: true }),
    updateSubscriptionValue: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<AsaasClient>;
  const access = { invalidate: jest.fn() } as unknown as jest.Mocked<BillingAccessService>;
  const webhook = {
    reprocess: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<BillingWebhookService>;
  const billing = {
    chargeSeatsAdjustedBySuperadmin: jest.fn().mockResolvedValue({ id: 'chg_pix' }),
    cancelarAddonsDaEmpresa: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<BillingService>;
  const service = new SuperadminBillingService(repo, asaas, access, webhook, billing, logger);
  return { service, repo, asaas, access, webhook, billing };
}

/**
 * Poderes do superusuário (R33/R35). Toda ação aqui muda o que a empresa pode fazer
 * e/ou o que ela paga — e toda ação precisa invalidar o cache do gate, senão o efeito
 * demora até 30s para valer.
 */
describe('SuperadminBillingService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('empresa sem assinatura → 404 em vez de agir no vazio', async () => {
    const { service } = make(null);
    await expect(service.getCompanyDetail('c1')).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('assentos', () => {
    it('não deixa reduzir abaixo dos assentos ocupados', async () => {
      const { service, repo } = make(makeSub({ purchasedSeats: 5 }), 3);
      await expect(service.adjustSeats('c1', { total: 2 })).rejects.toThrow(/em uso/);
      expect(repo.updateSubscription).not.toHaveBeenCalled();
    });

    it('aumentar cobra pelo mesmo caminho do self-service e não entrega de graça (C14)', async () => {
      const { service, repo, billing } = make(makeSub({ purchasedSeats: 3 }), 1);
      await service.adjustSeats('c1', { total: 5 });

      expect(billing.chargeSeatsAdjustedBySuperadmin).toHaveBeenCalledWith('c1', 2, 'superadmin');
      expect(repo.updateSubscription).not.toHaveBeenCalled();
    });

    it('cortesia entrega o assento sem cobrar, com motivo registrado', async () => {
      const { service, repo, billing, access } = make(makeSub({ purchasedSeats: 3 }), 1);
      await service.adjustSeats('c1', { total: 4, cortesia: true, motivo: 'acordo comercial' });

      expect(billing.chargeSeatsAdjustedBySuperadmin).not.toHaveBeenCalled();
      expect(repo.updateSubscription).toHaveBeenCalledWith('sub_1', { purchasedSeats: 4 });
      expect(access.invalidate).toHaveBeenCalledWith('c1');
    });

    it('cortesia sem motivo é recusada (isenção precisa ser justificada)', async () => {
      const { service, repo } = make(makeSub({ purchasedSeats: 3 }), 1);
      await expect(service.adjustSeats('c1', { total: 4, cortesia: true })).rejects.toThrow(
        /motivo/,
      );
      expect(repo.updateSubscription).not.toHaveBeenCalled();
    });

    it('reduzir aplica na hora e invalida o cache do gate', async () => {
      const { service, repo, access, billing } = make(makeSub({ purchasedSeats: 5 }), 1);
      await service.adjustSeats('c1', { total: 3 });
      expect(billing.chargeSeatsAdjustedBySuperadmin).not.toHaveBeenCalled();
      expect(repo.updateSubscription).toHaveBeenCalledWith('sub_1', { purchasedSeats: 3 });
      expect(access.invalidate).toHaveBeenCalledWith('c1');
    });

    it('o valor da recorrência acompanha os assentos ajustados (C4)', async () => {
      const { service, asaas } = make(makeSub({ method: 'monthly_card', purchasedSeats: 5 }), 1);
      await service.adjustSeats('c1', { total: 4 });
      // 4 assentos = 49,90 + 3×19,90 = 109,60
      expect(asaas.updateSubscriptionValue).toHaveBeenCalledWith('asub_1', 109.6);
    });

    it('falha ao sincronizar o valor não desfaz o ajuste (best-effort)', async () => {
      const { service, repo, asaas } = make(
        makeSub({ method: 'monthly_card', purchasedSeats: 5 }),
        1,
      );
      asaas.updateSubscriptionValue.mockRejectedValue(new Error('asaas fora'));
      await expect(service.adjustSeats('c1', { total: 4 })).resolves.toBeDefined();
      expect(repo.updateSubscription).toHaveBeenCalledWith('sub_1', { purchasedSeats: 4 });
    });

    it('no anual não há recorrência para sincronizar', async () => {
      const { service, asaas } = make(makeSub({ method: 'annual_pix', purchasedSeats: 5 }), 1);
      await service.adjustSeats('c1', { total: 4 });
      expect(asaas.updateSubscriptionValue).not.toHaveBeenCalled();
    });
  });

  describe('cortesia', () => {
    it('conceder encerra a recorrência no Asaas e zera método/trava', async () => {
      const { service, repo, asaas, access } = make();
      await service.setCourtesy('c1', { grant: true });

      expect(asaas.deleteSubscription).toHaveBeenCalledWith('asub_1');
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({
          status: 'courtesy',
          method: null,
          asaasSubscriptionId: null,
          superadminLocked: false,
        }),
      );
      expect(access.invalidate).toHaveBeenCalledWith('c1');
    });

    it('falha no Asaas não impede a cortesia (best-effort)', async () => {
      const { service, repo, asaas } = make();
      asaas.deleteSubscription.mockRejectedValue(new Error('asaas down'));
      await expect(service.setCourtesy('c1', { grant: true })).resolves.toBeDefined();
      expect(repo.updateSubscription).toHaveBeenCalled();
    });

    it('revogar cortesia joga a empresa para somente-leitura', async () => {
      const { service, repo } = make(makeSub({ status: 'courtesy', asaasSubscriptionId: null }));
      await service.setCourtesy('c1', { grant: false });
      expect(repo.updateSubscription).toHaveBeenCalledWith('sub_1', { status: 'readonly' });
    });
  });

  describe('cancelamento', () => {
    it('no fim do ciclo apenas agenda (mantém a recorrência para o cron encerrar)', async () => {
      const { service, repo, asaas } = make();
      await service.cancel('c1', { atPeriodEnd: true });
      expect(asaas.deleteSubscription).not.toHaveBeenCalled();
      expect(repo.updateSubscription).toHaveBeenCalledWith('sub_1', { cancelAtPeriodEnd: true });
    });

    it('imediato encerra a recorrência no Asaas e zera o id (sem cobrança extra)', async () => {
      const { service, repo, asaas } = make();
      await service.cancel('c1', { atPeriodEnd: false });
      expect(asaas.deleteSubscription).toHaveBeenCalledWith('asub_1');
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({
          status: 'canceled',
          asaasSubscriptionId: null,
          cancelAtPeriodEnd: false,
        }),
      );
    });
  });

  describe('trava manual', () => {
    it('travar mexe só na trava — não marca a assinatura como vencida', async () => {
      const { service, repo, access } = make();
      await service.setReadonly('c1', { locked: true });
      expect(repo.updateSubscription).toHaveBeenCalledWith('sub_1', { superadminLocked: true });
      expect(access.invalidate).toHaveBeenCalledWith('c1');
    });

    it('suspender exige motivo e fecha a porta (R44)', async () => {
      const { service, repo, access } = make();
      await expect(service.suspendAccess('c1', { suspended: true })).rejects.toThrow(/motivo/);

      await service.suspendAccess('c1', { suspended: true, motivo: 'fraude confirmada' });
      expect(repo.updateSubscription).toHaveBeenCalledWith('sub_1', { accessSuspended: true });
      expect(access.invalidate).toHaveBeenCalledWith('c1');
    });

    it('devolver o acesso não exige motivo', async () => {
      const { service, repo } = make();
      await service.suspendAccess('c1', { suspended: false });
      expect(repo.updateSubscription).toHaveBeenCalledWith('sub_1', { accessSuspended: false });
    });

    it('destravar não muda o status sozinho (quem reativa é o pagamento)', async () => {
      const { service, repo } = make(makeSub({ superadminLocked: true, status: 'readonly' }));
      await service.setReadonly('c1', { locked: false });
      expect(repo.updateSubscription).toHaveBeenCalledWith('sub_1', { superadminLocked: false });
    });

    it('estender trial devolve a empresa para trial e destrava', async () => {
      const { service, repo } = make(makeSub({ status: 'readonly' }));
      await service.extendTrial('c1', { endsAt: '2026-08-30T00:00:00.000Z' });
      expect(repo.updateSubscription).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({ status: 'trial', superadminLocked: false }),
      );
    });
  });

  describe('reprocessar webhook (B1 — resgate manual)', () => {
    it('reprocessa zerando as tentativas', async () => {
      const { service, repo, webhook } = make();
      repo.findWebhookEventById.mockResolvedValue({
        id: 'evt_1',
        type: 'PAYMENT_RECEIVED',
        payload: { id: 'e1' },
        attempts: 6,
        status: 'dead',
      } as never);

      await service.reprocessWebhook('evt_1');

      expect(webhook.reprocess).toHaveBeenCalledWith({
        id: 'evt_1',
        type: 'PAYMENT_RECEIVED',
        payload: { id: 'e1' },
        attempts: 0,
      });
    });

    it('evento inexistente → 404', async () => {
      const { service, webhook } = make();
      await expect(service.reprocessWebhook('nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(webhook.reprocess).not.toHaveBeenCalled();
    });
  });

  describe('getRevenueSummary', () => {
    it('normaliza o anual por 12 e ignora quem não paga', async () => {
      const { service, repo } = make();
      repo.subscriptionsForRevenue.mockResolvedValue([
        // 2 mensais de 1 assento: 2 × R$49,90
        { status: 'active', method: 'monthly_card', purchasedSeats: 1, _count: { _all: 2 } },
        // 1 anual de 1 assento: R$430,92/ano = R$35,91/mês (não R$430,92!)
        { status: 'active', method: 'annual_pix', purchasedSeats: 1, _count: { _all: 1 } },
        // Cortesia e trial não entram no MRR — não pagam.
        { status: 'courtesy', method: null, purchasedSeats: 9, _count: { _all: 1 } },
        { status: 'trial', method: null, purchasedSeats: 5, _count: { _all: 3 } },
      ] as never);

      const r = await service.getRevenueSummary();

      expect(r.mrrCents).toBe(4990 * 2 + Math.round(44910 / 12));
      expect(r.ativas).toBe(3);
    });

    it('separa a receita em risco de quem está em atraso ou bloqueado', async () => {
      const { service, repo } = make();
      repo.subscriptionsForRevenue.mockResolvedValue([
        { status: 'active', method: 'monthly_card', purchasedSeats: 1, _count: { _all: 1 } },
        { status: 'past_due', method: 'monthly_card', purchasedSeats: 3, _count: { _all: 1 } },
        { status: 'readonly', method: 'monthly_card', purchasedSeats: 1, _count: { _all: 2 } },
      ] as never);

      const r = await service.getRevenueSummary();

      // Em risco não infla o MRR: são coisas diferentes para quem opera.
      expect(r.mrrCents).toBe(4990);
      expect(r.inadimplencia).toEqual({ count: 3, mrrEmRiscoCents: 8970 + 4990 * 2 });
    });
  });
});
