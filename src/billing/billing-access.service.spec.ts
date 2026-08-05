import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { BillingAccessService } from './billing-access.service';
import { BillingRepository } from './billing.repository';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

interface SubSummary {
  status: string;
  trialEndsAt: Date | null;
  method: string | null;
  superadminLocked?: boolean;
}

function make(summary: SubSummary | null, enabled = true) {
  const repo = {
    getSubscriptionSummary: jest.fn().mockResolvedValue(summary),
  } as unknown as jest.Mocked<BillingRepository>;
  const config = {
    get: () => (enabled ? 'true' : 'false'),
  } as unknown as ConfigService;
  return { service: new BillingAccessService(repo, config, logger), repo };
}

const past = new Date(Date.now() - 86_400_000);
const future = new Date(Date.now() + 86_400_000);

/**
 * Regras de acesso (R20/R21/R22/R24/R38). "Bloqueado" = somente-leitura por empresa.
 * Este spec fixa quem bloqueia e quem NÃO bloqueia — mexer aqui é mexer no que o
 * cliente pode fazer depois de pagar (ou deixar de pagar).
 */
describe('BillingAccessService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('billing desligado nunca bloqueia, mesmo em readonly', async () => {
    const { service } = make(
      { status: 'readonly', trialEndsAt: null, method: 'monthly_card' },
      false,
    );
    await expect(service.isBlocked('c1')).resolves.toBe(false);
  });

  it('readonly com plano anterior → bloqueado por assinatura vencida', async () => {
    const { service } = make({ status: 'readonly', trialEndsAt: null, method: 'annual_pix' });
    const s = await service.getSummary('c1');
    expect(s).toMatchObject({ blocked: true, blockReason: 'subscription_expired' });
  });

  it('readonly sem nunca ter assinado → bloqueado por fim de teste', async () => {
    const { service } = make({ status: 'readonly', trialEndsAt: past, method: null });
    const s = await service.getSummary('c1');
    expect(s).toMatchObject({ blocked: true, blockReason: 'trial_ended' });
  });

  it('canceled bloqueia (R26)', async () => {
    const { service } = make({ status: 'canceled', trialEndsAt: null, method: 'monthly_card' });
    await expect(service.isBlocked('c1')).resolves.toBe(true);
  });

  it('trial vencido bloqueia ao vivo, sem esperar o cron (R6)', async () => {
    const { service } = make({ status: 'trial', trialEndsAt: past, method: null });
    const s = await service.getSummary('c1');
    expect(s).toMatchObject({ blocked: true, blockReason: 'trial_ended' });
  });

  it('trial vigente não bloqueia e pede assinatura (CTA)', async () => {
    const { service } = make({ status: 'trial', trialEndsAt: future, method: null });
    const s = await service.getSummary('c1');
    expect(s).toMatchObject({ blocked: false, needsSubscription: true });
  });

  it('past_due NÃO bloqueia — é carência (R22)', async () => {
    const { service } = make({ status: 'past_due', trialEndsAt: null, method: 'monthly_card' });
    const s = await service.getSummary('c1');
    expect(s).toMatchObject({ blocked: false, needsSubscription: true });
  });

  it('active não bloqueia nem pede assinatura (R38: anual pago segue o ciclo inteiro)', async () => {
    const { service } = make({ status: 'active', trialEndsAt: null, method: 'annual_pix' });
    const s = await service.getSummary('c1');
    expect(s).toMatchObject({ blocked: false, needsSubscription: false });
  });

  it('courtesy é isenta: não bloqueia nem pede assinatura', async () => {
    const { service } = make({ status: 'courtesy', trialEndsAt: null, method: null });
    const s = await service.getSummary('c1');
    expect(s).toMatchObject({ blocked: false, needsSubscription: false });
  });

  it('empresa sem assinatura fica liberada (com aviso no log)', async () => {
    const { service } = make(null);
    const s = await service.getSummary('c1');
    expect(s).toMatchObject({ status: null, blocked: false });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('cacheia o resumo e só relê o banco depois de invalidar (R24)', async () => {
    const { service, repo } = make({ status: 'readonly', trialEndsAt: null, method: 'annual_pix' });
    await service.getSummary('c1');
    await service.getSummary('c1');
    expect(repo.getSubscriptionSummary).toHaveBeenCalledTimes(1);

    // Pagamento confirmado → o webhook invalida → a próxima leitura já vê `active`.
    repo.getSubscriptionSummary.mockResolvedValue({
      status: 'active',
      trialEndsAt: null,
      method: 'annual_pix',
    } as never);
    service.invalidate('c1');
    await expect(service.isBlocked('c1')).resolves.toBe(false);
    expect(repo.getSubscriptionSummary).toHaveBeenCalledTimes(2);
  });

  it('o cache é por empresa (invalidar uma não afeta a outra)', async () => {
    const { service, repo } = make({ status: 'active', trialEndsAt: null, method: 'annual_pix' });
    await service.getSummary('c1');
    await service.getSummary('c2');
    expect(repo.getSubscriptionSummary).toHaveBeenCalledTimes(2);
    service.invalidate('c1');
    await service.getSummary('c2');
    expect(repo.getSubscriptionSummary).toHaveBeenCalledTimes(2);
  });

  it('trava do superadmin não é "assinatura vencida" (C13)', async () => {
    const { service } = make({
      status: 'readonly',
      trialEndsAt: null,
      method: 'annual_pix',
      superadminLocked: true,
    });
    const s = await service.getSummary('c1');
    expect(s).toMatchObject({ blocked: true, blockReason: 'admin_locked' });
  });

  it('a mensagem do bloqueio muda conforme o motivo', () => {
    expect(BillingAccessService.mensagemDeBloqueio('trial_ended')).toMatch(/teste/i);
    expect(BillingAccessService.mensagemDeBloqueio('admin_locked')).toMatch(/limitado/i);
    expect(BillingAccessService.mensagemDeBloqueio('admin_suspended')).toMatch(/suspenso/i);
    expect(BillingAccessService.mensagemDeBloqueio('subscription_expired')).toMatch(/vencida/i);
  });

  it('assertCanMutate lança COMPANY_BLOCKED com o motivo', async () => {
    const { service } = make({ status: 'trial', trialEndsAt: past, method: null });
    await expect(service.assertCanMutate('c1')).rejects.toBeInstanceOf(ForbiddenException);
    await service.assertCanMutate('c1').catch((err: ForbiddenException) => {
      expect(err.getResponse()).toMatchObject({
        code: 'COMPANY_BLOCKED',
        reason: 'trial_ended',
      });
    });
  });

  it('assertCanMutate passa quando a empresa está liberada', async () => {
    const { service } = make({ status: 'active', trialEndsAt: null, method: 'monthly_card' });
    await expect(service.assertCanMutate('c1')).resolves.toBeUndefined();
  });
});
