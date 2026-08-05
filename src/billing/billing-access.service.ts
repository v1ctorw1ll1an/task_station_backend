import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { BillingRepository } from './billing.repository';

const TTL_MS = 30_000;

export type BlockReason =
  | 'trial_ended'
  | 'subscription_expired'
  | 'admin_locked'
  | 'admin_suspended';

/**
 * O que a empresa consegue fazer agora:
 * - `ok` — tudo liberado.
 * - `read_only` — usa o app inteiro: consulta (`GET`) e apaga (`DELETE`), mas não
 *   cria nem altera. É o estado de quem não pagou (R20).
 * - `suspended` — porta fechada: nem leitura. Só cobrança e exportação (R44).
 */
export type BillingMode = 'ok' | 'read_only' | 'suspended';

export interface BillingSummary {
  /** Status da assinatura (null quando a empresa não tem assinatura). */
  status: string | null;
  /** O que a empresa pode fazer — é isto que o gate e a UI consultam. */
  mode: BillingMode;
  /** Atalho de `mode !== 'ok'`: há restrição em vigor. */
  blocked: boolean;
  /** Motivo da restrição (define a mensagem mostrada ao usuário). */
  blockReason: BlockReason | null;
  /** Deve exibir CTA suave de assinar: billing ligado, ainda com acesso (trial/carência). */
  needsSubscription: boolean;
  /** Fim do período de teste, quando em trial. */
  trialEndsAt: Date | null;
}

/**
 * Fonte de verdade do estado de cobrança por empresa, com cache curto em memória.
 * Consultado pelo gate de escrita (`isBlocked`) e pelo resumo do front (`getSummary`,
 * para a tela de paywall + CTA de assinar).
 *
 * Bloqueado ⇔ billing ligado e assinatura `readonly`/`canceled` OU trial com
 * `trialEndsAt` no passado (detectado ao vivo, sem esperar o cron). Trial vigente
 * e `past_due` (carência) NÃO bloqueiam — ainda têm acesso, com CTA de assinar.
 * Empresa sem assinatura fica liberada.
 *
 * O cache é invalidado explicitamente (`invalidate`) por webhook/cron/superadmin
 * a cada transição, então a reativação por pagamento é imediata (R24).
 */
@Injectable()
export class BillingAccessService {
  private readonly cache = new Map<string, { summary: BillingSummary; expiresAt: number }>();

  constructor(
    private readonly repo: BillingRepository,
    private readonly config: ConfigService,
    @InjectPinoLogger(BillingAccessService.name)
    private readonly logger: PinoLogger,
  ) {}

  async getSummary(companyId: string): Promise<BillingSummary> {
    const cached = this.cache.get(companyId);
    if (cached && cached.expiresAt > Date.now()) return cached.summary;

    const sub = await this.repo.getSubscriptionSummary(companyId);
    if (!sub) {
      this.logger.warn({ companyId }, 'Empresa sem assinatura — acesso liberado');
    }

    const now = new Date();
    const status = sub?.status ?? null;
    const billingEnabled = this.config.get<string>('BILLING_ENABLED') === 'true';

    const trialExpired = status === 'trial' && sub?.trialEndsAt != null && sub.trialEndsAt < now;
    const semPagamento = status === 'readonly' || status === 'canceled' || trialExpired;
    // Suspensão é decisão manual e vale mesmo com a cobrança desligada — é a saída
    // para fraude/abuso, não uma consequência de inadimplência.
    // Decisão manual do superusuário vale sempre; restrição por falta de pagamento
    // só existe com a cobrança ligada.
    const suspensa = sub?.accessSuspended === true;
    const travaManual = sub?.superadminLocked === true;
    const mode: BillingMode = suspensa
      ? 'suspended'
      : travaManual || (billingEnabled && semPagamento)
        ? 'read_only'
        : 'ok';
    const blocked = mode !== 'ok';

    // Travado à mão pelo superadmin → nem teste encerrado nem inadimplência: oferecer
    // planos não resolveria (o pagamento não destrava), e chamar de "vencida" um
    // cliente em dia é mentira (C13). Nunca assinou (sem método) → teste encerrado;
    // tinha plano pago → assinatura vencida.
    const blockReason: BlockReason | null = !blocked
      ? null
      : mode === 'suspended'
        ? 'admin_suspended'
        : sub?.superadminLocked
          ? 'admin_locked'
          : sub?.method == null
            ? 'trial_ended'
            : 'subscription_expired';

    const needsSubscription =
      billingEnabled && !blocked && (status === 'trial' || status === 'past_due');

    const summary: BillingSummary = {
      status,
      mode,
      blocked,
      blockReason,
      needsSubscription,
      trialEndsAt: sub?.trialEndsAt ?? null,
    };

    this.cache.set(companyId, { summary, expiresAt: Date.now() + TTL_MS });
    return summary;
  }

  async isBlocked(companyId: string): Promise<boolean> {
    return (await this.getSummary(companyId)).blocked;
  }

  async getMode(companyId: string): Promise<BillingMode> {
    return (await this.getSummary(companyId)).mode;
  }

  /**
   * Enforcement fora do gate, para rotas cujo escopo só aparece no corpo/no recurso
   * (task-sessions, eventos, link de convidado). Use `assertCanMutate` para criar ou
   * alterar e `assertCanDelete` para apagar — apagar continua liberado em
   * somente-leitura (R20).
   */
  async assertCanMutate(companyId: string): Promise<void> {
    const s = await this.getSummary(companyId);
    if (s.blocked) {
      throw new ForbiddenException({
        code: 'COMPANY_BLOCKED',
        reason: s.blockReason,
        message: BillingAccessService.mensagemDeBloqueio(s.blockReason),
      });
    }
  }

  /** Apagar é do cliente: só a suspensão total impede. */
  async assertCanDelete(companyId: string): Promise<void> {
    const s = await this.getSummary(companyId);
    if (s.mode === 'suspended') {
      throw new ForbiddenException({
        code: 'COMPANY_BLOCKED',
        reason: s.blockReason,
        message: BillingAccessService.mensagemDeBloqueio(s.blockReason),
      });
    }
  }

  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }

  /** Mensagem do bloqueio — o motivo muda o que o usuário deve fazer. */
  static mensagemDeBloqueio(reason: BlockReason | null): string {
    switch (reason) {
      case 'trial_ended':
        return 'Seu teste grátis terminou. Assine um plano para continuar.';
      case 'admin_locked':
        return 'Acesso limitado pela administração do TaskDY: consulta liberada, edição bloqueada. Fale com o suporte.';
      case 'admin_suspended':
        return 'Acesso suspenso pela administração do TaskDY. Fale com o suporte para regularizar.';
      default:
        return 'Assinatura vencida. Regularize a cobrança para continuar.';
    }
  }
}
