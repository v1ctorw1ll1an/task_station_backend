import { ConfigService } from '@nestjs/config';
import { addDays, addMonths, addYears, format } from 'date-fns';
import { PinoLogger } from 'nestjs-pino';
import { Prisma } from '../generated/prisma/client';
import { MailerService } from '../mailer/mailer.service';
import { MetricsService } from '../metrics/metrics.service';
import { AsaasClient } from './asaas/asaas.client';
import { BillingAccessService } from './billing-access.service';
import { BillingAlertsService } from './billing-alerts.service';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingRepository } from './billing.repository';
import { BillingSchedulerService } from './billing-scheduler.service';
import { BillingService } from './billing.service';
import { BillingWebhookService } from './billing-webhook.service';

/**
 * Simulação da vida de uma assinatura ao longo do tempo.
 *
 * Aqui não se testa método isolado: monta-se o módulo inteiro (service + webhook +
 * cron + gate de acesso) sobre um banco em memória e um Asaas de mentira, e o
 * relógio é movido de verdade. Cada cenário é uma história plausível de cliente —
 * inclusive as caóticas (webhook duplicado, fora de ordem, perdido, estorno,
 * duplo clique) — e o que se afirma no fim é **o que o cliente paga e o que ele
 * consegue acessar**.
 */

// ── Banco em memória ────────────────────────────────────────────────────────

interface FakeCharge {
  id: string;
  subscriptionId: string;
  companyId: string;
  type: string;
  paymentKind: string;
  status: string;
  amountCents: number;
  installments: number;
  seats: number;
  seatsDelta: number | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  seatAddonId: string | null;
  asaasPaymentId: string | null;
  asaasCheckoutId: string | null;
  checkoutUrl: string | null;
  checkoutExpiresAt: Date | null;
  pixPayload: string | null;
  pixEncodedImage: string | null;
  pixExpiresAt: Date | null;
  invoiceUrl: string | null;
  paidAt: Date | null;
  failedAt: Date | null;
  failReason: string | null;
  metadata: unknown;
  createdAt: Date;
}

interface FakeEvent {
  id: string;
  asaasEventId: string;
  type: string;
  asaasPaymentId?: string;
  payload: unknown;
  status: string;
  attempts: number;
  nextAttemptAt: Date | null;
  processedAt: Date | null;
  error: string | null;
  createdAt: Date;
}

const COMPANY = 'company-1';

interface FakeAddon {
  id: string;
  companyId: string;
  subscriptionId: string;
  seats: number;
  unitPriceCents: number;
  amountCents: number;
  paymentKind: string;
  status: string;
  asaasSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  graceUntil: Date | null;
  activatedAt: Date | null;
  canceledAt: Date | null;
}

interface FakeMember {
  userId: string;
  role: string;
  scheduledRemovalAt: Date | null;
  removedAt: Date | null;
}

class FakeDb {
  seq = 0;
  members: FakeMember[] = [
    { userId: 'dono', role: 'admin', scheduledRemovalAt: null, removedAt: null },
  ];
  sub: Record<string, unknown> = {
    id: 'sub-1',
    companyId: COMPANY,
    status: 'trial',
    method: null,
    purchasedSeats: 1,
    addonSeats: 0,
    seatsAtNextRenewal: null,
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    graceUntil: null,
    cancelAtPeriodEnd: false,
    superadminLocked: false,
    accessSuspended: false,
    asaasCustomerId: null,
    asaasSubscriptionId: null,
    canceledAt: null,
    // Perfil de cobrança completo: sem ele nenhum pagamento sai do lugar.
    billingName: 'Fulano de Tal',
    billingEmail: 'f@t.com',
    billingCpfCnpj: '12345678909',
    billingPostalCode: '01001000',
    billingStreet: 'Praça da Sé',
    billingAddressNumber: '10',
    billingAddressComplement: null,
    billingNeighborhood: 'Sé',
    billingCity: 'São Paulo',
    billingState: 'SP',
    billingPhone: '11987654321',
  };
  charges: FakeCharge[] = [];
  addons: FakeAddon[] = [];
  /** Fila do advisory lock por empresa (uma empresa só neste harness). */
  lock: Promise<void> = Promise.resolve();
  events: FakeEvent[] = [];
  notices = new Set<string>();

  /**
   * Ids no formato UUID. Importa: o webhook só aceita `externalReference` que **pareça**
   * um id nosso (`UUID_RE`), então ids fake fora do formato esconderiam o caminho de
   * resolução que roda em produção.
   */
  id(prefix: string): string {
    this.seq += 1;
    const n = String(this.seq).padStart(12, '0');
    const grupo = prefix.slice(0, 4).padEnd(4, '0');
    return `00000000-0000-4000-8${grupo.slice(0, 3)}-${n}`;
  }
}

function makeRepo(db: FakeDb): BillingRepository {
  const subOf = (id: string) => (db.sub.id === id ? db.sub : null);
  const apply = (target: Record<string, unknown>, data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in v) {
        target[k] = (target[k] as number) + (v as { increment: number }).increment;
      } else {
        target[k] = v;
      }
    }
  };

  const repo = {
    // ── assinatura ──
    findSubscriptionByCompany: (companyId: string) =>
      Promise.resolve(db.sub.companyId === companyId ? { ...db.sub } : null),
    findSubscriptionById: (id: string) => Promise.resolve(subOf(id) ? { ...db.sub } : null),
    findSubscriptionByAsaasSubscriptionId: (asaasId: string) =>
      Promise.resolve(db.sub.asaasSubscriptionId === asaasId ? { ...db.sub } : null),
    findSubscriptionByAsaasCustomerId: (customerId: string) =>
      Promise.resolve(db.sub.asaasCustomerId === customerId ? { ...db.sub } : null),
    getSubscriptionSummary: (companyId: string) =>
      Promise.resolve(
        db.sub.companyId === companyId
          ? {
              status: db.sub.status,
              trialEndsAt: db.sub.trialEndsAt,
              method: db.sub.method,
              superadminLocked: db.sub.superadminLocked,
              accessSuspended: db.sub.accessSuspended,
              currentPeriodEnd: db.sub.currentPeriodEnd,
            }
          : null,
      ),
    updateSubscription: (id: string, data: Record<string, unknown>) => {
      if (subOf(id)) apply(db.sub, data);
      return Promise.resolve({ ...db.sub });
    },
    countOccupiedSeats: () => Promise.resolve(db.members.filter((m) => !m.removedAt).length),
    findCompanySeatHolders: () =>
      Promise.resolve(
        db.members
          .filter((m) => !m.removedAt)
          .map((m) => ({
            userId: m.userId,
            role: m.role,
            scheduledRemovalAt: m.scheduledRemovalAt,
            user: { name: m.userId, email: `${m.userId}@acme.com` },
          })),
      ),
    scheduleSeatRemovals: (_c: string, userIds: string[], at: Date) => {
      for (const m of db.members) m.scheduledRemovalAt = null;
      for (const m of db.members) if (userIds.includes(m.userId)) m.scheduledRemovalAt = at;
      return Promise.resolve();
    },
    applyScheduledSeatRemovals: (_c: string, now: Date) => {
      let count = 0;
      for (const m of db.members) {
        if (m.scheduledRemovalAt && !m.removedAt) {
          m.removedAt = now;
          m.scheduledRemovalAt = null;
          count++;
        }
      }
      return Promise.resolve({ count });
    },
    getCompanyFiscal: () =>
      Promise.resolve({ legalName: 'ACME', taxId: '11222333000181', adminEmail: 'a@b.com' }),
    findCompanyAdminEmails: () => Promise.resolve(['admin@acme.com']),
    /**
     * Serializa como o advisory lock do Postgres serializa. Sem isto o duplo clique
     * simultâneo passaria pelos dois caminhos ao mesmo tempo aqui e não em produção —
     * o teste ficaria mais severo que a realidade e esconderia o comportamento real.
     */
    withCompanyLock: <T>(_c: string, fn: () => Promise<T>): Promise<T> => {
      const proximo = db.lock.then(fn, fn);
      db.lock = proximo.then(
        () => undefined,
        () => undefined,
      );
      return proximo;
    },

    // ── cobranças ──
    createCharge: (data: Record<string, unknown>) => {
      const charge: FakeCharge = {
        id: db.id('chg'),
        seatsDelta: null,
        seatAddonId: null,
        periodStart: null,
        periodEnd: null,
        asaasPaymentId: null,
        asaasCheckoutId: null,
        checkoutUrl: null,
        checkoutExpiresAt: null,
        pixPayload: null,
        pixEncodedImage: null,
        pixExpiresAt: null,
        invoiceUrl: null,
        paidAt: null,
        failedAt: null,
        failReason: null,
        metadata: null,
        createdAt: new Date(),
        ...(data as Partial<FakeCharge>),
      } as FakeCharge;
      // Espelha o índice único parcial `billing_charges_one_open_per_intent`.
      const clash = db.charges.some(
        (c) =>
          c.subscriptionId === charge.subscriptionId &&
          c.type === charge.type &&
          c.status === 'pending' &&
          ['subscription', 'seat'].includes(c.type),
      );
      if (clash) {
        throw new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      db.charges.push(charge);
      return Promise.resolve({ ...charge });
    },
    updateCharge: (id: string, data: Record<string, unknown>) => {
      const c = db.charges.find((x) => x.id === id);
      if (c) apply(c as unknown as Record<string, unknown>, data);
      return Promise.resolve({ ...(c as FakeCharge) });
    },
    findChargeById: (id: string) => Promise.resolve(db.charges.find((c) => c.id === id) ?? null),
    findChargeByAsaasPaymentId: (paymentId: string) =>
      Promise.resolve(db.charges.find((c) => c.asaasPaymentId === paymentId) ?? null),
    findOpenChargeByIntent: (subscriptionId: string, type: string) =>
      Promise.resolve(
        [...db.charges]
          .reverse()
          .find(
            (c) => c.subscriptionId === subscriptionId && c.type === type && c.status === 'pending',
          ) ?? null,
      ),
    markChargePaid: (id: string) => {
      const c = db.charges.find((x) => x.id === id);
      if (!c || c.status === 'paid') return Promise.resolve({ count: 0 });
      c.status = 'paid';
      c.paidAt = new Date();
      return Promise.resolve({ count: 1 });
    },
    // Espelha o repo real: qualquer cobrança pendente, não só Pix com QR válido —
    // é o que a tela usa para oferecer o "Já paguei" no cartão.
    findLatestPendingCharge: (companyId: string) =>
      Promise.resolve(
        [...db.charges]
          .reverse()
          .find((c) => c.companyId === companyId && c.status === 'pending') ?? null,
      ),
    findPendingPixCharge: (companyId: string, now: Date = new Date()) =>
      Promise.resolve(
        [...db.charges]
          .reverse()
          .find(
            (c) =>
              c.companyId === companyId &&
              c.paymentKind === 'pix' &&
              c.status === 'pending' &&
              c.pixPayload != null &&
              c.pixExpiresAt != null &&
              c.pixExpiresAt > now,
          ) ?? null,
      ),
    findPendingChargesByCompany: (companyId: string, since: Date, take = 3) =>
      Promise.resolve(
        [...db.charges]
          .reverse()
          .filter(
            (c) =>
              c.companyId === companyId &&
              c.status === 'pending' &&
              c.asaasPaymentId != null &&
              c.createdAt >= since,
          )
          .slice(0, take),
      ),
    findStalePendingCharges: (cutoff: Date) =>
      Promise.resolve(
        db.charges.filter(
          (c) => c.status === 'pending' && c.createdAt < cutoff && c.asaasPaymentId != null,
        ),
      ),
    findExpiredPixCharges: (now: Date) =>
      Promise.resolve(
        db.charges.filter(
          (c) =>
            c.status === 'pending' &&
            c.paymentKind === 'pix' &&
            c.pixExpiresAt != null &&
            c.pixExpiresAt < now,
        ),
      ),
    findLatestPaidCoveringCharge: (companyId: string, now: Date) =>
      Promise.resolve(
        [...db.charges]
          .reverse()
          .find(
            (c) =>
              c.companyId === companyId &&
              c.status === 'paid' &&
              ['subscription', 'renewal'].includes(c.type) &&
              c.periodEnd != null &&
              c.periodEnd > now,
          ) ?? null,
      ),
    findCharges: (companyId: string) =>
      Promise.resolve([db.charges.filter((c) => c.companyId === companyId), db.charges.length]),
    findChargeByCheckoutId: (checkoutId: string) =>
      Promise.resolve(db.charges.find((c) => c.asaasCheckoutId === checkoutId) ?? null),
    findExpiredCheckoutCharges: (now: Date) =>
      Promise.resolve(
        db.charges.filter(
          (c) => c.status === 'pending' && c.checkoutExpiresAt != null && c.checkoutExpiresAt < now,
        ),
      ),
    findUnboundCheckoutCharges: (criadasAte: Date) =>
      Promise.resolve(
        db.charges.filter(
          (c) =>
            c.status === 'pending' &&
            c.asaasCheckoutId != null &&
            c.asaasPaymentId == null &&
            c.createdAt < criadasAte,
        ),
      ),

    // ── assentos adicionais do anual ──
    createSeatAddon: (data: Record<string, unknown>) => {
      const addon: FakeAddon = {
        id: db.id('addon'),
        asaasSubscriptionId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        graceUntil: null,
        activatedAt: null,
        canceledAt: null,
        ...(data as Partial<FakeAddon>),
      } as FakeAddon;
      db.addons.push(addon);
      return Promise.resolve({ ...addon });
    },
    updateSeatAddon: (id: string, data: Record<string, unknown>) => {
      const a = db.addons.find((x) => x.id === id);
      if (a) apply(a as unknown as Record<string, unknown>, data);
      return Promise.resolve({ ...(a as FakeAddon) });
    },
    findSeatAddonById: (id: string) => Promise.resolve(db.addons.find((a) => a.id === id) ?? null),
    findSeatAddonByAsaasSubscription: (asaasId: string) =>
      Promise.resolve(db.addons.find((a) => a.asaasSubscriptionId === asaasId) ?? null),
    findSeatAddons: (companyId: string, status?: string[]) =>
      Promise.resolve(
        db.addons.filter(
          (a) => a.companyId === companyId && (!status || status.includes(a.status)),
        ),
      ),
    findSeatAddonsPastGrace: (now: Date) =>
      Promise.resolve(
        db.addons.filter(
          (a) => a.status === 'past_due' && a.graceUntil != null && a.graceUntil < now,
        ),
      ),
    findSeatAddonsRenewingBy: (limite: Date) =>
      Promise.resolve(
        db.addons.filter(
          (a) =>
            ['active', 'past_due'].includes(a.status) &&
            a.currentPeriodEnd != null &&
            a.currentPeriodEnd <= limite,
        ),
      ),
    sumActiveAddonSeats: (companyId: string) =>
      Promise.resolve(
        db.addons
          .filter((a) => a.companyId === companyId && ['active', 'past_due'].includes(a.status))
          .reduce((total, a) => total + a.seats, 0),
      ),
    syncAddonSeats: (_id: string, companyId: string) => {
      const total = db.addons
        .filter((a) => a.companyId === companyId && ['active', 'past_due'].includes(a.status))
        .reduce((t, a) => t + a.seats, 0);
      db.sub.addonSeats = total;
      return Promise.resolve(total);
    },
    findSubscriptionsWithAddons: () =>
      Promise.resolve(
        db.addons.length
          ? [{ id: db.sub.id, companyId: db.sub.companyId, addonSeats: db.sub.addonSeats }]
          : [],
      ),

    // ── cron ──
    findTrials: () =>
      Promise.resolve(db.sub.status === 'trial' ? [{ ...db.sub, id: db.sub.id }] : []),
    findPastDue: () => Promise.resolve(db.sub.status === 'past_due' ? [{ ...db.sub }] : []),
    findActiveAnnual: () =>
      Promise.resolve(
        db.sub.status === 'active' && db.sub.method === 'annual_card' ? [{ ...db.sub }] : [],
      ),
    findCancelDue: (now: Date) =>
      Promise.resolve(
        ['active', 'past_due', 'readonly'].includes(String(db.sub.status)) &&
          db.sub.cancelAtPeriodEnd === true &&
          db.sub.currentPeriodEnd != null &&
          (db.sub.currentPeriodEnd as Date) <= now
          ? [{ ...db.sub }]
          : [],
      ),
    findSubscriptionsNeedingSync: (cutoff: Date) =>
      Promise.resolve(
        db.sub.asaasSubscriptionId != null &&
          ['trial', 'active', 'past_due'].includes(String(db.sub.status)) &&
          (db.sub.currentPeriodEnd == null || (db.sub.currentPeriodEnd as Date) <= cutoff)
          ? [{ ...db.sub }]
          : [],
      ),
    findStuckSubscriptions: (now: Date) =>
      Promise.resolve(
        db.sub.superadminLocked === false &&
          ['trial', 'readonly', 'past_due'].includes(String(db.sub.status)) &&
          (db.sub.currentPeriodEnd == null || (db.sub.currentPeriodEnd as Date) < now) &&
          db.charges.some(
            (c) =>
              c.status === 'paid' &&
              ['subscription', 'renewal'].includes(c.type) &&
              c.periodEnd != null &&
              c.periodEnd > now,
          )
          ? [{ ...db.sub }]
          : [],
      ),
    countLiveSubscriptions: () =>
      Promise.resolve(['active', 'past_due'].includes(String(db.sub.status)) ? 1 : 0),
    createNotice: (data: { subscriptionId: string; kind: string; anchorAt: Date }) => {
      const key = `${data.subscriptionId}|${data.kind}|${data.anchorAt.toISOString()}`;
      if (db.notices.has(key)) {
        throw new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      db.notices.add(key);
      return Promise.resolve({});
    },

    // ── webhooks ──
    createWebhookEvent: (data: Record<string, unknown>) => {
      if (db.events.some((e) => e.asaasEventId === data.asaasEventId)) {
        throw new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      const evt: FakeEvent = {
        id: db.id('evt'),
        processedAt: null,
        error: null,
        createdAt: new Date(),
        ...(data as Partial<FakeEvent>),
      } as FakeEvent;
      db.events.push(evt);
      return Promise.resolve({ ...evt });
    },
    markWebhookProcessed: (id: string, status: string, error?: string) => {
      const e = db.events.find((x) => x.id === id);
      if (e)
        Object.assign(e, {
          status,
          error: error ?? null,
          processedAt: new Date(),
          nextAttemptAt: null,
        });
      return Promise.resolve({});
    },
    scheduleWebhookRetry: (id: string, attempts: number, nextAttemptAt: Date, error: string) => {
      const e = db.events.find((x) => x.id === id);
      if (e)
        Object.assign(e, { status: 'failed', attempts, nextAttemptAt, error, processedAt: null });
      return Promise.resolve({});
    },
    markWebhookDead: (id: string, attempts: number, error: string) => {
      const e = db.events.find((x) => x.id === id);
      if (e) Object.assign(e, { status: 'dead', attempts, nextAttemptAt: null, error });
      return Promise.resolve({});
    },
    findRetriableWebhookEvents: (now: Date, limit: number) =>
      Promise.resolve(
        db.events
          .filter(
            (e) =>
              ['received', 'failed'].includes(e.status) &&
              e.nextAttemptAt != null &&
              e.nextAttemptAt <= now,
          )
          .slice(0, limit),
      ),
    findLastWebhookEventAt: () =>
      Promise.resolve(db.events.length ? db.events[db.events.length - 1].createdAt : null),
  };
  return repo as unknown as BillingRepository;
}

// ── Asaas de mentira ────────────────────────────────────────────────────────

interface FakePayment {
  id: string;
  status: string;
  value: number;
  dueDate: string;
  subscription?: string;
  externalReference?: string;
  customer?: string;
  invoiceUrl: string;
}

interface FakeCheckout {
  id: string;
  status: string;
  value: number;
  externalReference?: string;
  cycle?: string;
  nextDueDate?: string;
  recurrent: boolean;
}

class FakeAsaas {
  payments: FakePayment[] = [];
  subscriptions: {
    id: string;
    status: string;
    value: number;
    cycle?: string;
    nextDueDate: string;
    externalReference?: string;
  }[] = [];
  checkouts: FakeCheckout[] = [];
  seq = 0;
  deletedPayments: string[] = [];

  private id(p: string) {
    this.seq += 1;
    return `${p}_${this.seq}`;
  }

  client(): AsaasClient {
    // Arrow functions capturam o `this` da instância — o Asaas de mentira guarda
    // estado (pagamentos, assinaturas) entre as chamadas.
    return {
      createCustomer: () => Promise.resolve({ id: 'cus_1' }),
      updateCustomer: (id: string) => Promise.resolve({ id }),
      createCheckout: (input: {
        items: { value: number }[];
        externalReference?: string;
        chargeTypes: string[];
        subscription?: { cycle: string; nextDueDate: string };
      }) => {
        const chk: FakeCheckout = {
          id: this.id('chk'),
          status: 'ACTIVE',
          value: input.items[0]?.value ?? 0,
          externalReference: input.externalReference,
          cycle: input.subscription?.cycle,
          nextDueDate: input.subscription?.nextDueDate,
          recurrent: input.chargeTypes.includes('RECURRENT'),
        };
        this.checkouts.push(chk);
        return Promise.resolve({ id: chk.id, link: `https://asaas/${chk.id}`, status: 'ACTIVE' });
      },
      cancelCheckout: (id: string) => {
        const c = this.checkouts.find((x) => x.id === id);
        if (c) c.status = 'CANCELED';
        return Promise.resolve({ id, status: 'CANCELED' });
      },
      listPayments: (q: { externalReference?: string }) =>
        Promise.resolve({
          data: q.externalReference
            ? this.payments.filter((p) => p.externalReference === q.externalReference)
            : this.payments,
        }),
      createSubscription: (input: {
        value: number;
        nextDueDate: string;
        cycle?: string;
        externalReference?: string;
      }) => {
        const sub = {
          id: this.id('asub'),
          status: 'ACTIVE',
          value: input.value,
          cycle: input.cycle,
          nextDueDate: input.nextDueDate,
          externalReference: input.externalReference,
        };
        this.subscriptions.push(sub);
        // Asaas já emite a 1ª cobrança do ciclo.
        this.emitSubscriptionPayment(sub.id, input.value, input.nextDueDate);
        return Promise.resolve(sub);
      },
      updateSubscriptionValue: (id: string, value: number) => {
        const s = this.subscriptions.find((x) => x.id === id);
        if (s) s.value = value;
        return Promise.resolve(s ?? {});
      },
      deleteSubscription: (id: string) => {
        const s = this.subscriptions.find((x) => x.id === id);
        if (s) s.status = 'DELETED';
        return Promise.resolve({ deleted: true, id });
      },
      listCustomerSubscriptions: () =>
        Promise.resolve({ data: this.subscriptions.filter((s) => s.status === 'ACTIVE') }),
      listSubscriptionPayments: (subId: string) =>
        Promise.resolve({ data: this.payments.filter((p) => p.subscription === subId) }),
      createPayment: (input: {
        value?: number;
        totalValue?: number;
        externalReference?: string;
      }) => {
        const p: FakePayment = {
          id: this.id('pay'),
          status: 'PENDING',
          value: input.totalValue ?? input.value ?? 0,
          dueDate: format(new Date(), 'yyyy-MM-dd'),
          externalReference: input.externalReference,
          customer: 'cus_1',
          invoiceUrl: 'http://invoice',
        };
        this.payments.push(p);
        return Promise.resolve(p);
      },
      deletePayment: (id: string) => {
        this.deletedPayments.push(id);
        this.payments = this.payments.filter((p) => p.id !== id);
        return Promise.resolve({ deleted: true, id });
      },
      getPayment: (id: string) => {
        const p = this.payments.find((x) => x.id === id);
        if (!p) return Promise.reject(new Error(`pagamento ${id} não existe`));
        return Promise.resolve(p);
      },
      getPixQrCode: () =>
        Promise.resolve({
          payload: '000201-pix',
          encodedImage: 'img',
          expirationDate: format(addDays(new Date(), 1), 'yyyy-MM-dd HH:mm:ss'),
        }),
    } as unknown as AsaasClient;
  }

  /** Cobrança gerada pela recorrência do Asaas (1ª ou renovação). */
  emitSubscriptionPayment(subId: string, value: number, dueDate: string): FakePayment {
    const p: FakePayment = {
      id: this.id('pay'),
      status: 'PENDING',
      value,
      dueDate,
      subscription: subId,
      externalReference: this.subscriptions.find((s) => s.id === subId)?.externalReference,
      customer: 'cus_1',
      invoiceUrl: 'http://invoice',
    };
    this.payments.push(p);
    return p;
  }

  /**
   * Simula o que o Asaas faz quando o cliente paga um checkout: cria a assinatura (se
   * for recorrente) e emite a cobrança. Devolve o pagamento gerado, para o teste
   * entregá-lo ao webhook como o provedor entregaria.
   */
  payCheckout(checkoutId: string): FakePayment {
    const chk = this.checkouts.find((c) => c.id === checkoutId);
    if (!chk) throw new Error(`checkout ${checkoutId} não existe`);
    chk.status = 'PAID';

    if (chk.recurrent) {
      const sub = {
        id: this.id('asub'),
        status: 'ACTIVE',
        value: chk.value,
        cycle: chk.cycle,
        nextDueDate: chk.nextDueDate ?? format(new Date(), 'yyyy-MM-dd'),
        externalReference: chk.externalReference,
      };
      this.subscriptions.push(sub);
      const p = this.emitSubscriptionPayment(sub.id, chk.value, sub.nextDueDate);
      p.status = 'CONFIRMED';
      return p;
    }

    const p: FakePayment = {
      id: this.id('pay'),
      status: 'CONFIRMED',
      value: chk.value,
      dueDate: format(new Date(), 'yyyy-MM-dd'),
      externalReference: chk.externalReference,
      customer: 'cus_1',
      invoiceUrl: 'http://invoice',
    };
    this.payments.push(p);
    return p;
  }

  lastCheckout(): FakeCheckout {
    return this.checkouts[this.checkouts.length - 1];
  }

  last(): FakePayment {
    return this.payments[this.payments.length - 1];
  }

  setStatus(id: string, status: string): void {
    const p = this.payments.find((x) => x.id === id);
    if (p) p.status = status;
  }
}

// ── Montagem ────────────────────────────────────────────────────────────────

const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

function makeHarness() {
  const db = new FakeDb();
  const repo = makeRepo(db);
  const fakeAsaas = new FakeAsaas();
  const asaas = fakeAsaas.client();
  const config = {
    // Taxa de juros ZERO: parcelar não encarece (R36/R45). É o valor de produção.
    get: (k: string, d?: string) =>
      ({
        BILLING_ENABLED: 'true',
        BILLING_ANNUAL_INTEREST_MONTHLY: '0',
        FRONTEND_URL: 'https://app.taskdy.test',
      })[k] ?? d,
  } as unknown as ConfigService;
  const mailer = {
    sendPaymentConfirmedEmail: jest.fn().mockResolvedValue(undefined),
    sendPaymentFailedEmail: jest.fn().mockResolvedValue(undefined),
    sendSeatPixEmail: jest.fn().mockResolvedValue(undefined),
    sendTrialEndingEmail: jest.fn().mockResolvedValue(undefined),
    sendTrialEndedEmail: jest.fn().mockResolvedValue(undefined),
    sendReadOnlyActivatedEmail: jest.fn().mockResolvedValue(undefined),
    sendAnnualRenewalReminderEmail: jest.fn().mockResolvedValue(undefined),
    sendBillingOpsAlert: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<MailerService>;
  const metrics = {
    billingWebhook: jest.fn(),
    billingReconcile: jest.fn(),
    billingAlert: jest.fn(),
    billingLastWebhookAge: jest.fn(),
  } as unknown as MetricsService;

  const access = new BillingAccessService(repo, config, silentLogger);
  const alerts = new BillingAlertsService(mailer, metrics, silentLogger);
  const checkout = new BillingCheckoutService(asaas, repo, config, silentLogger);
  const webhook = new BillingWebhookService(
    repo,
    asaas,
    access,
    checkout,
    mailer,
    alerts,
    metrics,
    silentLogger,
  );
  const service = new BillingService(repo, asaas, config, webhook, checkout, mailer, silentLogger);
  const scheduler = new BillingSchedulerService(
    repo,
    mailer,
    access,
    webhook,
    service,
    checkout,
    asaas,
    config,
    alerts,
    metrics,
    silentLogger,
  );

  let evtSeq = 0;
  const helpers = {
    db,
    asaas: fakeAsaas,
    service,
    webhook,
    scheduler,
    access,
    mailer,
    checkout,

    now: () => new Date(),
    travelTo(date: Date) {
      jest.setSystemTime(date);
    },
    advanceDays(days: number) {
      jest.setSystemTime(addDays(new Date(), days));
    },
    /** Roda o cron (a "passagem de tempo" do sistema). */
    async tick() {
      await scheduler.run(new Date());
      access.invalidate(COMPANY);
    },
    /** Pagamento confirmado no Asaas + webhook entregue. */
    async pay(paymentId: string, event = 'PAYMENT_RECEIVED') {
      fakeAsaas.setStatus(paymentId, 'RECEIVED');
      evtSeq += 1;
      await webhook.handle({
        id: `evt_${evtSeq}`,
        event,
        payment: { id: paymentId } as never,
      });
      access.invalidate(COMPANY);
    },
    /**
     * Simula o cliente concluindo o pagamento na página do Asaas: o provedor cria a
     * assinatura/cobrança e nos avisa. É o caminho de TODO pagamento com cartão agora.
     */
    async pagarCheckoutAberto(): Promise<FakePayment> {
      const pagamento = fakeAsaas.payCheckout(fakeAsaas.lastCheckout().id);
      evtSeq += 1;
      await webhook.handle({
        id: `evt_${evtSeq}`,
        event: 'PAYMENT_CONFIRMED',
        payment: { id: pagamento.id } as never,
      });
      access.invalidate(COMPANY);
      return pagamento;
    },
    /** Entrega um evento sem mexer no status do pagamento (fora de ordem, duplicado…). */
    async deliver(paymentId: string, event: string, eventId?: string) {
      evtSeq += 1;
      await webhook.handle({
        id: eventId ?? `evt_${evtSeq}`,
        event,
        payment: { id: paymentId } as never,
      });
      access.invalidate(COMPANY);
    },
    /**
     * A cobrança do ciclo seguinte. Como no Asaas, existe **uma** por vez: se já há
     * fatura em aberto, é ela — inclusive com o valor que a proração de assentos
     * possa ter ajustado (R17). Só emite outra depois que a anterior é paga.
     */
    renewalPayment(): FakePayment {
      const aberta = helpers.faturaPendente();
      if (aberta) return aberta;
      const asub = db.sub.asaasSubscriptionId as string;
      const sub = fakeAsaas.subscriptions.find((s) => s.id === asub);
      return fakeAsaas.emitSubscriptionPayment(
        asub,
        sub?.value ?? 0,
        format(new Date(), 'yyyy-MM-dd'),
      );
    },
    /** A fatura em aberto da recorrência, se houver. */
    faturaPendente(): FakePayment | undefined {
      return fakeAsaas.payments.find(
        (p) => p.subscription === db.sub.asaasSubscriptionId && p.status === 'PENDING',
      );
    },
    /** Como o Asaas: assim que o ciclo começa, a fatura do próximo já fica em aberto. */
    emitirFaturaDoCicloSeguinte(): FakePayment {
      const asub = db.sub.asaasSubscriptionId as string;
      const sub = fakeAsaas.subscriptions.find((s) => s.id === asub);
      return fakeAsaas.emitSubscriptionPayment(
        asub,
        sub?.value ?? 0,
        format((db.sub.currentPeriodEnd as Date | null) ?? new Date(), 'yyyy-MM-dd'),
      );
    },
    async blocked(): Promise<boolean> {
      access.invalidate(COMPANY);
      return access.isBlocked(COMPANY);
    },
    async mode() {
      access.invalidate(COMPANY);
      return access.getMode(COMPANY);
    },
    sub: () => db.sub,
    /** Define quantas pessoas ocupam assento (a 1ª é sempre a admin dona). */
    setMembers(total: number) {
      db.members = Array.from({ length: total }, (_, i) => ({
        userId: i === 0 ? 'dono' : `membro-${i}`,
        role: i === 0 ? 'admin' : 'member',
        scheduledRemovalAt: null,
        removedAt: null,
      }));
    },
    membrosAtivos: () => db.members.filter((m) => !m.removedAt).map((m) => m.userId),
    /** Valor que o Asaas cobrará na próxima renovação. */
    recurringValue(): number | undefined {
      return fakeAsaas.subscriptions.find((s) => s.id === db.sub.asaasSubscriptionId)?.value;
    },
    card: () => ({ creditCard: {} as never, holderInfo: {} as never }),
  };
  return helpers;
}

type Harness = ReturnType<typeof makeHarness>;

/** Empresa em trial de 7 dias, como nasce pelo fluxo de criação/self-signup. */
function startTrial(h: Harness, days = 7) {
  h.db.sub.status = 'trial';
  h.db.sub.trialEndsAt = addDays(new Date(), days);
}

/**
 * Atalho: empresa com mensal ativo e ciclo aberto.
 *
 * O caminho é o de produção: abre o checkout, o cliente paga na página do Asaas, o
 * provedor cria a assinatura e nos avisa — é nesse aviso que o `asaasSubscriptionId`
 * passa a existir do nosso lado.
 */
async function subscribedMonthly(h: Harness) {
  startTrial(h);
  await h.service.subscribeMonthly(COMPANY, {});
  await h.pagarCheckoutAberto();
}

describe('Cenários de cobrança ao longo do tempo', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-10T12:00:00Z'));
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());

  // ── Trial ────────────────────────────────────────────────────────────────

  describe('trial', () => {
    it('7 dias de acesso total; no 8º o acesso cai', async () => {
      const h = makeHarness();
      startTrial(h);

      await expect(h.blocked()).resolves.toBe(false);
      h.advanceDays(6);
      await h.tick();
      await expect(h.blocked()).resolves.toBe(false);

      h.advanceDays(2); // D+8
      await h.tick();
      expect(h.sub().status).toBe('readonly');
      await expect(h.blocked()).resolves.toBe(true);
      expect(h.mailer.sendTrialEndedEmail).toHaveBeenCalled();
    });

    it('avisa em D-3 e D-1 uma única vez, mesmo com o cron rodando de hora em hora', async () => {
      const h = makeHarness();
      startTrial(h);

      h.advanceDays(4); // faltam 3
      await h.tick();
      await h.tick();
      await h.tick();
      expect(h.mailer.sendTrialEndingEmail).toHaveBeenCalledTimes(1);

      h.advanceDays(2); // falta 1
      await h.tick();
      await h.tick();
      expect(h.mailer.sendTrialEndingEmail).toHaveBeenCalledTimes(2);
    });

    it('trial expirado bloqueia na hora, sem esperar o cron', async () => {
      const h = makeHarness();
      startTrial(h, 1);
      h.advanceDays(2);
      await expect(h.blocked()).resolves.toBe(true);
      expect(h.sub().status).toBe('trial'); // o cron ainda não passou
    });
  });

  // ── Renovação mensal ─────────────────────────────────────────────────────

  describe('renovação mensal', () => {
    it('paga, renova e segue ativa por três ciclos', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      expect(h.sub().status).toBe('active');
      const fim1 = h.sub().currentPeriodEnd as Date;
      expect(fim1.getTime()).toBe(addMonths(new Date(), 1).getTime());

      for (let ciclo = 0; ciclo < 2; ciclo++) {
        h.advanceDays(30);
        await h.pay(h.renewalPayment().id);
        expect(h.sub().status).toBe('active');
        await expect(h.blocked()).resolves.toBe(false);
      }
      // Uma cobrança inicial + duas renovações, todas pagas.
      expect(h.db.charges.filter((c) => c.status === 'paid')).toHaveLength(3);
    });

    it('cartão recusado → carência de 3 dias com acesso mantido → pagou, volta ao normal', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);

      h.advanceDays(30);
      const renovacao = h.renewalPayment();
      h.asaas.setStatus(renovacao.id, 'OVERDUE');
      await h.deliver(renovacao.id, 'PAYMENT_OVERDUE');

      expect(h.sub().status).toBe('past_due');
      await expect(h.blocked()).resolves.toBe(false); // carência NÃO bloqueia (R22)
      expect(h.mailer.sendPaymentFailedEmail).toHaveBeenCalled();

      h.advanceDays(2);
      await h.tick();
      await expect(h.blocked()).resolves.toBe(false); // ainda dentro dos 3 dias

      await h.pay(renovacao.id);
      expect(h.sub().status).toBe('active');
      expect(h.sub().graceUntil).toBeNull();
    });

    it('cartão vencido: trocar o cartão quita o atraso e não reinicia o ciclo (R48)', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      const asubAntiga = h.sub().asaasSubscriptionId as string;

      h.advanceDays(30);
      const renovacao = h.renewalPayment();
      h.asaas.setStatus(renovacao.id, 'OVERDUE');
      await h.deliver(renovacao.id, 'PAYMENT_OVERDUE');
      expect(h.sub().status).toBe('past_due');

      // Trocar o cartão e pagar o atraso viraram duas coisas separadas: o cartão é
      // digitado no Asaas (checkout novo) e a fatura vencida é paga na página dela.
      expect(await h.service.getFaturaEmAtraso(COMPANY)).toEqual({ invoiceUrl: 'http://invoice' });
      const r = await h.service.trocarCartao(COMPANY);
      expect(r.checkoutUrl).toContain('https://asaas/');
      // A recorrência antiga sai de cena (senão cobraria em dobro). Com ela some o
      // caminho até a fatura vencida — por isso o link é buscado ANTES da troca.
      expect(h.asaas.subscriptions.find((s) => s.id === asubAntiga)?.status).toBe('DELETED');

      // O webhook do pagamento é que reativa — mesmo caminho de sempre.
      await h.pay(renovacao.id);
      expect(h.sub().status).toBe('active');
      expect(h.sub().graceUntil).toBeNull();
    });

    it('carência esgotada bloqueia; pagar depois reativa', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);

      h.advanceDays(30);
      const renovacao = h.renewalPayment();
      h.asaas.setStatus(renovacao.id, 'OVERDUE');
      await h.deliver(renovacao.id, 'PAYMENT_OVERDUE');

      h.advanceDays(4); // estourou a carência
      await h.tick();
      expect(h.sub().status).toBe('readonly');
      await expect(h.blocked()).resolves.toBe(true);

      await h.pay(renovacao.id);
      expect(h.sub().status).toBe('active');
      await expect(h.blocked()).resolves.toBe(false);
    });
  });

  // ── Assentos ─────────────────────────────────────────────────────────────

  describe('assentos', () => {
    it('mensal: cobrança avulsa de valor cheio, e o assento só entra quando ela é paga', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      const fimOriginal = h.sub().currentPeriodEnd as Date;

      h.advanceDays(15);
      await h.service.buySeats(COMPANY, { quantity: 1 });

      // Uma cobrança avulsa nasce, com o preço cheio do assento — o dia 15 não desconta.
      const cobranca = h.db.charges.find((c) => c.type === 'seat');
      expect(cobranca).toMatchObject({ status: 'pending', amountCents: 1990, seatsDelta: 1 });
      // E o assento NÃO vale ainda: quem paga primeiro é o cliente.
      expect(h.sub().purchasedSeats).toBe(1);
      expect(h.recurringValue()).toBe(49.9);
      expect(h.sub().currentPeriodEnd).toEqual(fimOriginal);

      await h.pagarCheckoutAberto();

      // Pago: assento na hora e mensalidade nova valendo da PRÓXIMA cobrança.
      expect(h.sub().purchasedSeats).toBe(2);
      expect(h.recurringValue()).toBe(69.8);
    });

    it('mensal: adicionar e remover dentro do mês não devolve dinheiro', async () => {
      // O que antes exigia acumular proração agora é trivial: o mês do assento já foi
      // pago cheio, e reduzir só mexe na cobrança seguinte.
      const h = makeHarness();
      await subscribedMonthly(h);

      await h.service.buySeats(COMPANY, { quantity: 10 });
      await h.pagarCheckoutAberto();
      expect(h.sub().purchasedSeats).toBe(11);
      h.setMembers(1);

      h.advanceDays(28);
      await h.service.reduceSeats(COMPANY, { quantity: 10 });

      // A mensalidade cai só do próximo ciclo; o mês usado já está pago.
      expect(h.recurringValue()).toBe(49.9);
      expect(h.sub().purchasedSeats).toBe(11);
      expect(h.sub().seatsAtNextRenewal).toBe(1);
      // Nenhuma devolução: não existe cobrança negativa nem estorno.
      expect(h.db.charges.every((c) => c.amountCents >= 0)).toBe(true);
    });

    it('cancelar não deixa cobrança de assento pendurada', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);

      await h.service.buySeats(COMPANY, { quantity: 2 });
      await h.pagarCheckoutAberto();

      await h.service.cancel(COMPANY);

      // O assento já foi pago cheio: não sobra saldo a cobrar no cancelamento.
      expect(h.db.charges.filter((c) => c.type === 'seat' && c.status === 'pending')).toHaveLength(
        0,
      );
      expect(h.sub().cancelAtPeriodEnd).toBe(true);
    });

    it('mensal: a cobrança do ciclo corrente não é mexida pela compra de assento', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      const faturaDoCiclo = h.faturaPendente()?.value;

      h.advanceDays(15);
      await h.service.buySeats(COMPANY, { quantity: 1 });
      await h.pagarCheckoutAberto();

      // O mês corrente foi contratado com os assentos antigos e já está pago/emitido.
      expect(h.faturaPendente()?.value).toBe(faturaDoCiclo);
    });

    it('compra de assento não paga expira e não libera nada', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);

      await h.service.buySeats(COMPANY, { quantity: 2, paymentKind: 'pix' });
      expect(h.db.charges.some((c) => c.type === 'seat')).toBe(true);

      h.advanceDays(3); // Pix venceu
      await h.tick();

      const cobranca = h.db.charges.find((c) => c.type === 'seat');
      expect(cobranca?.status).toBe('expired');
      expect(h.sub().purchasedSeats).toBe(1);
    });

    it('checkout de assento expirado libera o intento para uma nova tentativa', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);

      await h.service.buySeats(COMPANY, { quantity: 1 });
      // Enquanto vivo, bloqueia outra compra.
      await expect(h.service.buySeats(COMPANY, { quantity: 1 })).rejects.toThrow(
        /aguardando pagamento/,
      );

      h.advanceDays(2); // passou das 24 h do checkout
      await h.tick();
      expect(h.db.charges.find((c) => c.type === 'seat')?.status).toBe('expired');

      // Agora dá para tentar de novo.
      await expect(h.service.buySeats(COMPANY, { quantity: 1 })).resolves.toBeDefined();
    });

    it('reduzir vale só na renovação, e a renovação aplica o novo total', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      h.db.sub.purchasedSeats = 3;
      h.setMembers(1);

      await h.service.reduceSeats(COMPANY, { quantity: 2 });
      expect(h.sub().purchasedSeats).toBe(3); // ainda paga por 3 neste ciclo
      expect(h.sub().seatsAtNextRenewal).toBe(1);
      expect(h.recurringValue()).toBe(49.9); // já ajustado para a próxima cobrança

      h.advanceDays(30);
      await h.pay(h.renewalPayment().id);

      expect(h.sub().purchasedSeats).toBe(1);
      expect(h.sub().seatsAtNextRenewal).toBeNull();
    });

    it('comprar e reduzir no mesmo ciclo: a renovação aplica o resultado líquido', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);

      h.advanceDays(10);
      await h.service.buySeats(COMPANY, { quantity: 2 });
      await h.pagarCheckoutAberto();
      expect(h.sub().purchasedSeats).toBe(3);

      await h.service.reduceSeats(COMPANY, { quantity: 1 });
      expect(h.sub().purchasedSeats).toBe(3);
      expect(h.sub().seatsAtNextRenewal).toBe(2);

      h.advanceDays(25);
      await h.pay(h.renewalPayment().id);
      expect(h.sub().purchasedSeats).toBe(2);
      expect(h.recurringValue()).toBe(69.8); // 2 assentos
    });

    it('reduzir com todo mundo ocupando exige dizer quem sai', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      h.db.sub.purchasedSeats = 3;
      h.setMembers(3);
      await expect(h.service.reduceSeats(COMPANY, { quantity: 1 })).rejects.toThrow(
        /Selecione mais 1 pessoa/,
      );
    });

    it('quem foi escolhido para sair trabalha até o fim do ciclo pago e cai na renovação', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      h.db.sub.purchasedSeats = 3;
      h.setMembers(3); // dono + membro-1 + membro-2

      await h.service.reduceSeats(COMPANY, { quantity: 1, userIds: ['membro-2'] });

      // Ciclo pago: ninguém perde acesso ainda.
      expect(h.membrosAtivos()).toContain('membro-2');
      expect(h.sub().purchasedSeats).toBe(3);

      h.advanceDays(15);
      await h.tick();
      expect(h.membrosAtivos()).toContain('membro-2');

      h.advanceDays(20);
      await h.pay(h.renewalPayment().id);

      expect(h.membrosAtivos()).toEqual(['dono', 'membro-1']);
      expect(h.sub().purchasedSeats).toBe(2);
      expect(h.recurringValue()).toBe(69.8);
    });

    it('devolver assento vago não tira ninguém', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      h.db.sub.purchasedSeats = 4;
      h.setMembers(2); // 2 assentos vagos

      await h.service.reduceSeats(COMPANY, { quantity: 2 });

      h.advanceDays(31);
      await h.pay(h.renewalPayment().id);
      expect(h.membrosAtivos()).toHaveLength(2);
      expect(h.sub().purchasedSeats).toBe(2);
    });

    it('não deixa selecionar mais gente do que assentos removidos', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      h.db.sub.purchasedSeats = 3;
      h.setMembers(3);
      await expect(
        h.service.reduceSeats(COMPANY, { quantity: 1, userIds: ['membro-1', 'membro-2'] }),
      ).rejects.toThrow(/selecionou 2 pessoa/);
    });

    it('não deixa a empresa ficar sem administrador', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      h.db.sub.purchasedSeats = 2;
      h.setMembers(2);
      await expect(
        h.service.reduceSeats(COMPANY, { quantity: 1, userIds: ['dono'] }),
      ).rejects.toThrow(/administrador/);
    });

    it('mudar de ideia: a última seleção substitui a anterior', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      h.db.sub.purchasedSeats = 3;
      h.setMembers(3);

      await h.service.reduceSeats(COMPANY, { quantity: 1, userIds: ['membro-1'] });
      await h.service.reduceSeats(COMPANY, { quantity: 1, userIds: ['membro-2'] });

      h.advanceDays(31);
      await h.pay(h.renewalPayment().id);
      expect(h.membrosAtivos()).toEqual(['dono', 'membro-1']);
    });

    it('a saída agendada não acontece se a renovação não for paga', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      h.db.sub.purchasedSeats = 2;
      h.setMembers(2);
      await h.service.reduceSeats(COMPANY, { quantity: 1, userIds: ['membro-1'] });

      h.advanceDays(31);
      const renovacao = h.renewalPayment();
      h.asaas.setStatus(renovacao.id, 'OVERDUE');
      await h.deliver(renovacao.id, 'PAYMENT_OVERDUE');

      // Sem pagamento não há ciclo novo — ninguém sai e nada muda.
      expect(h.membrosAtivos()).toContain('membro-1');
      expect(h.sub().purchasedSeats).toBe(2);
    });

    it('anual: o cliente escolhe a forma de pagamento, não o plano (R45)', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY); // plano contratado no Pix
      await h.pay(h.asaas.last().id);

      // …e o assento pago no cartão, parcelado.
      await h.service.buySeats(COMPANY, { quantity: 1, paymentKind: 'credit_card' });

      const cobranca = h.db.charges.find((c) => c.type === 'seat');
      expect(cobranca).toMatchObject({ paymentKind: 'credit_card' });
      // Um ano cheio por assento — não depende do que falta do ciclo do plano.
      expect(cobranca!.amountCents).toBe(17910); // 1 × R$179,10

      const pago = h.asaas.payCheckout(h.asaas.lastCheckout().id);
      await h.deliver(pago.id, 'PAYMENT_CONFIRMED');
      expect(h.sub().addonSeats).toBe(1);
    });

    it('trocar a forma de pagamento exige cancelar a cobrança aberta (R46)', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      await h.pay(h.asaas.last().id);

      await h.service.buySeats(COMPANY, { quantity: 1, paymentKind: 'pix' });
      const pix = h.asaas.last();

      // Enquanto o Pix está de pé, não nasce uma segunda cobrança pagável.
      await expect(
        h.service.buySeats(COMPANY, { quantity: 1, paymentKind: 'credit_card' }),
      ).rejects.toThrow(/aguardando pagamento/);

      await h.service.cancelPendingSeatCharge(COMPANY);
      expect(h.asaas.deletedPayments).toContain(pix.id);

      // Cancelada, o cartão passa.
      await h.service.buySeats(COMPANY, { quantity: 1, paymentKind: 'credit_card' });
      expect(h.db.charges.filter((c) => c.type === 'seat' && c.status === 'pending')).toHaveLength(
        1,
      );
    });

    it('não cancela um Pix que o cliente acabou de pagar — concilia e libera o assento', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      await h.pay(h.asaas.last().id);

      await h.service.buySeats(COMPANY, { quantity: 1, paymentKind: 'pix' });
      const pix = h.asaas.last();
      // Pago no banco, webhook ainda não chegou.
      h.asaas.setStatus(pix.id, 'RECEIVED');

      await expect(h.service.cancelPendingSeatCharge(COMPANY)).rejects.toThrow(/já foi paga/);
      expect(h.asaas.deletedPayments).not.toContain(pix.id);
      // No anual o assento entra como assinatura própria — conciliado, ele já conta.
      expect(h.sub().addonSeats).toBe(1);
    });

    it('assento só é liberado para ocupação depois do pagamento (R18)', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      await h.pay(h.asaas.last().id);
      h.setMembers(1); // 1 comprado, 1 ocupado

      await expect(h.service.assertSeatAvailable(COMPANY)).rejects.toThrow(/em uso/);

      await h.service.buySeats(COMPANY, { quantity: 1, paymentKind: 'pix' });
      await expect(h.service.assertSeatAvailable(COMPANY)).rejects.toThrow(/em uso/);

      await h.pay(h.asaas.last().id);
      await expect(h.service.assertSeatAvailable(COMPANY)).resolves.toBeUndefined();
    });

    it('trial não dá assento de graça: 2º membro só depois de assinar (C14)', async () => {
      const h = makeHarness();
      startTrial(h);
      h.setMembers(1); // o assento incluído já está ocupado

      await expect(h.service.assertSeatAvailable(COMPANY)).rejects.toThrow(/Assine um plano/);

      // Assinou → compra o assento e aí sim entra mais gente.
      await h.service.subscribeAnnualPix(COMPANY);
      await h.pay(h.asaas.last().id);
      await h.service.buySeats(COMPANY, { quantity: 1, paymentKind: 'pix' });
      await h.pay(h.asaas.last().id);
      await expect(h.service.assertSeatAvailable(COMPANY)).resolves.toBeUndefined();
    });

    it('preview mostra a proração e o novo valor antes de confirmar', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      await h.pay(h.asaas.last().id);

      const preview = await h.service.previewSeatChange(COMPANY, 1, {
        quantity: 1,
        acao: 'comprar',
      });
      expect(preview).toMatchObject({
        cadencia: 'anual',
        seatsAtuais: 1,
        seatsDepois: 2,
        assentoDisponivelEm: 'no_pagamento',
      });
      // Um ano cheio por assento, cobrado agora.
      expect(preview.cobrancaAgoraCents).toBe(17910);
      // O PLANO não muda de valor: o assento extra vira assinatura à parte.
      expect(preview.valorDepoisCents).toBe(44910);
      expect(preview.valorHojeCents).toBe(44910);
    });

    it('o rótulo do preview mostra exatamente a base cobrada (C18)', async () => {
      // O rótulo e o preço saem da mesma conta — antes divergiam.
      const h = makeHarness();
      h.travelTo(new Date('2026-07-24T18:22:00Z'));
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      await h.pay(h.asaas.last().id);

      h.advanceDays(5);
      const preview = await h.service.previewSeatChange(COMPANY, 1, {
        quantity: 1,
        acao: 'comprar',
      });

      expect(preview.baseDoCalculo).toBe('1 × 179.10 por usuário/ano');
      expect(preview.cobrancaAgoraCents).toBe(17910);
    });

    it('no mensal o rótulo abre a conta do valor cheio', async () => {
      const h = makeHarness();
      h.travelTo(new Date('2026-03-10T12:00:00Z'));
      await subscribedMonthly(h);

      h.advanceDays(10);
      const preview = await h.service.previewSeatChange(COMPANY, 1, {
        quantity: 1,
        acao: 'comprar',
      });
      expect(preview.baseDoCalculo).toBe('1 × 19.90 por usuário');
      expect(preview.cobrancaAgoraCents).toBe(1990);
    });

    it('preview da redução não cobra nada e vale só na renovação', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      h.db.sub.purchasedSeats = 3;

      const preview = await h.service.previewSeatChange(COMPANY, 1, {
        quantity: 1,
        acao: 'reduzir',
      });
      expect(preview).toMatchObject({
        cadencia: 'mensal',
        seatsDepois: 2,
        disponivel: true,
        cobrancaAgoraCents: 0,
        assentoDisponivelEm: 'na_renovacao',
      });
      expect(preview.valorDepoisCents).toBe(6980);
    });

    it('não vende assento para quem está com a assinatura vencida', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      h.db.sub.status = 'readonly';
      await expect(h.service.buySeats(COMPANY, { quantity: 1, ...h.card() })).rejects.toThrow(
        /Regularize/,
      );
    });
  });

  // ── Anual ────────────────────────────────────────────────────────────────

  describe('plano anual', () => {
    it('paga o ano, atravessa 11 meses ativa e só bloqueia depois do vencimento', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      await h.pay(h.asaas.last().id);

      const fim = h.sub().currentPeriodEnd as Date;
      expect(fim.getTime()).toBe(addYears(new Date(), 1).getTime());

      h.advanceDays(330);
      await h.tick();
      await expect(h.blocked()).resolves.toBe(false);

      // O anual no Pix virou assinatura: o Asaas emite a cobrança do ano seguinte e a
      // falta de pagamento chega como atraso, com carência — igual ao mensal.
      h.advanceDays(40);
      const renovacao = h.renewalPayment();
      h.asaas.setStatus(renovacao.id, 'OVERDUE');
      await h.deliver(renovacao.id, 'PAYMENT_OVERDUE');
      expect(h.sub().status).toBe('past_due');
      await expect(h.blocked()).resolves.toBe(false); // carência não bloqueia

      h.advanceDays(4);
      await h.tick();
      expect(h.sub().status).toBe('readonly');
      await expect(h.blocked()).resolves.toBe(true);
    });

    it('anual no cartão (compra única) é lembrado em D-15, D-7 e D-1 sem repetir aviso', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualCard(COMPANY, { installments: 1 });
      await h.pagarCheckoutAberto();

      for (const dias of [350, 8, 6]) {
        h.advanceDays(dias);
        await h.tick();
        await h.tick();
      }
      expect(h.mailer.sendAnnualRenewalReminderEmail).toHaveBeenCalledTimes(3);
    });

    it('anual no Pix renova sozinho: pagar a cobrança do ano seguinte estende o ciclo', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      await h.pay(h.asaas.last().id);
      const fimDoPrimeiroAno = h.sub().currentPeriodEnd as Date;

      // Sem recontratar nada: o Asaas emite a cobrança do ano seguinte.
      h.advanceDays(366);
      await h.pay(h.renewalPayment().id);

      expect(h.sub().status).toBe('active');
      // Ciclo novo somado sobre "agora" (o anterior já tinha vencido) — o que importa
      // é ter avançado um ano e a empresa seguir liberada.
      expect((h.sub().currentPeriodEnd as Date).getTime()).toBeGreaterThan(
        addYears(fimDoPrimeiroAno, 1).getTime() - 86_400_000 * 2,
      );
      await expect(h.blocked()).resolves.toBe(false);
    });

    it('renova ANTES de vencer sem perder os dias já pagos (R47)', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      await h.pay(h.asaas.last().id);
      const fimOriginal = h.sub().currentPeriodEnd as Date;

      // Chega o lembrete de D-10 e o cliente renova na hora, ainda com acesso.
      h.advanceDays(355);
      await h.service.subscribeAnnualPix(COMPANY);
      await h.pay(h.asaas.last().id);

      // O ciclo novo começa onde o antigo termina — renovar cedo não encurta o ano.
      expect(h.sub().status).toBe('active');
      expect(h.sub().currentPeriodEnd).toEqual(addYears(fimOriginal, 1));
      expect(h.sub().currentPeriodStart).toEqual(fimOriginal);

      // E atravessa a data antiga sem bloquear em momento nenhum.
      h.advanceDays(20);
      await h.tick();
      await expect(h.blocked()).resolves.toBe(false);
    });

    it('troca anual → mensal: a recorrência começa no fim do ano pago, sem cobrar agora', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      await h.pay(h.asaas.last().id);
      const fimDoAno = h.sub().currentPeriodEnd as Date;
      const cobrancasAntes = h.db.charges.length;

      await h.service.subscribeMonthly(COMPANY, {});

      expect(h.sub().method).toBe('monthly_card');
      expect(h.sub().currentPeriodEnd).toEqual(fimDoAno); // o ano pago segue valendo
      // O checkout já nasce com a 1ª cobrança marcada para o fim do ano — nada hoje.
      expect(h.asaas.lastCheckout().nextDueDate).toBe(format(fimDoAno, 'yyyy-MM-dd'));
      // Nasce a cobrança da intenção (pendente), mas nenhuma é PAGA agora.
      expect(h.db.charges.length).toBe(cobrancasAntes + 1);
      expect(h.db.charges.filter((c) => c.status === 'paid')).toHaveLength(1);
    });

    it('troca mensal → anual: encerra a recorrência e o ano começa no fim do mês pago', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      const fimDoMes = h.sub().currentPeriodEnd as Date;
      const asubAntiga = h.sub().asaasSubscriptionId as string;

      await h.service.subscribeAnnualPix(COMPANY);
      await h.pay(h.asaas.last().id);

      // A recorrência mensal morre (senão cobraria o mês por cima do ano pago).
      expect(h.asaas.subscriptions.find((s) => s.id === asubAntiga)?.status).toBe('DELETED');
      expect(h.sub().method).toBe('annual_pix');
      expect(h.sub().currentPeriodEnd).toEqual(addYears(fimDoMes, 1));
    });
  });

  // ── Cancelamento e recontratação ─────────────────────────────────────────

  describe('cancelamento', () => {
    it('mantém o acesso até o fim do ciclo pago e só então bloqueia', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);

      await h.service.cancel(COMPANY);
      expect(h.sub().cancelAtPeriodEnd).toBe(true);
      await expect(h.blocked()).resolves.toBe(false);

      h.advanceDays(15);
      await h.tick();
      await expect(h.blocked()).resolves.toBe(false); // ciclo ainda corre

      h.advanceDays(20);
      await h.tick();
      expect(h.sub().status).toBe('canceled');
      await expect(h.blocked()).resolves.toBe(true);
    });

    it('cancelar encerra a recorrência no Asaas — não gera cobrança nova', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      const asub = h.sub().asaasSubscriptionId as string;

      await h.service.cancel(COMPANY);

      expect(h.asaas.subscriptions.find((s) => s.id === asub)?.status).toBe('DELETED');
      expect(h.sub().asaasSubscriptionId).toBeNull();
    });

    it('quem cancelou e voltou NÃO é cancelado de novo no fim do ciclo novo (C1)', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      await h.service.cancel(COMPANY);

      h.advanceDays(35);
      await h.tick();
      expect(h.sub().status).toBe('canceled');

      // Recontrata.
      await h.service.subscribeMonthly(COMPANY, {});
      await h.pagarCheckoutAberto();
      expect(h.sub().status).toBe('active');
      expect(h.sub().cancelAtPeriodEnd).toBe(false);

      h.advanceDays(35);
      await h.tick();
      // Sem pedido de cancelamento, a assinatura não pode se cancelar sozinha.
      expect(h.sub().status).not.toBe('canceled');
    });

    it('reativar leva ao checkout e a recorrência volta cobrando só no fim do ciclo pago', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      const fimDoCiclo = h.sub().currentPeriodEnd as Date;
      await h.service.cancel(COMPANY);

      const r = await h.service.reactivate(COMPANY);

      expect(h.sub().cancelAtPeriodEnd).toBe(false);
      // O cartão vive no Asaas: reativar é reinformá-lo lá.
      expect(r.checkoutUrl).toContain('https://asaas/');
      expect(h.asaas.lastCheckout().nextDueDate).toBe(format(fimDoCiclo, 'yyyy-MM-dd'));

      // Pago, a recorrência existe de novo — e nada foi cobrado por este ciclo.
      await h.pagarCheckoutAberto();
      expect(h.sub().asaasSubscriptionId).not.toBeNull();
    });

    it('em carência dá para cancelar, e a recorrência para de tentar o cartão (C9)', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      h.advanceDays(30);
      const renovacao = h.renewalPayment();
      h.asaas.setStatus(renovacao.id, 'OVERDUE');
      await h.deliver(renovacao.id, 'PAYMENT_OVERDUE');
      const asub = h.sub().asaasSubscriptionId as string;

      await h.service.cancel(COMPANY);

      expect(h.asaas.subscriptions.find((s) => s.id === asub)?.status).toBe('DELETED');
    });
  });

  // ── Caos ─────────────────────────────────────────────────────────────────

  describe('cenários caóticos', () => {
    it('duplo clique no checkout gera UMA cobrança só', async () => {
      const h = makeHarness();
      startTrial(h);

      await Promise.all([
        h.service.subscribeAnnualPix(COMPANY),
        h.service.subscribeAnnualPix(COMPANY).catch(() => null),
      ]);

      expect(h.db.charges.filter((c) => c.type === 'subscription')).toHaveLength(1);
      expect(h.asaas.payments).toHaveLength(1);
    });

    it('assinar duas vezes reaproveita o mesmo checkout — uma cobrança só', async () => {
      const h = makeHarness();
      startTrial(h);
      const primeiro = await h.service.subscribeMonthly(COMPANY, {});
      const segundo = await h.service.subscribeMonthly(COMPANY, {});

      // Mesmo link: quem cria a recorrência é o checkout, e dois checkouts do mesmo
      // pedido virariam duas recorrências cobrando todo mês.
      expect(segundo.checkoutUrl).toBe(primeiro.checkoutUrl);
      expect(h.asaas.checkouts).toHaveLength(1);
      expect(h.db.charges.filter((c) => c.type === 'subscription')).toHaveLength(1);

      // E só uma recorrência nasce quando o cliente paga.
      await h.pagarCheckoutAberto();
      expect(h.asaas.subscriptions.filter((s) => s.status === 'ACTIVE')).toHaveLength(1);
    });

    it('o mesmo pagamento confirmado três vezes ativa uma vez só', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      const pay = h.asaas.last().id;

      await h.pay(pay);
      const fim = h.sub().currentPeriodEnd as Date;
      await h.deliver(pay, 'PAYMENT_RECEIVED', 'evt-repetido');
      await h.deliver(pay, 'PAYMENT_CONFIRMED', 'evt-repetido-2');

      expect(h.sub().currentPeriodEnd).toEqual(fim); // ciclo não esticou
      expect(h.db.charges.filter((c) => c.status === 'paid')).toHaveLength(1);
    });

    it('evento fora de ordem: atraso chegando depois do pagamento não derruba a empresa', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      h.advanceDays(30);
      const renovacao = h.renewalPayment();

      await h.pay(renovacao.id); // pagou
      await h.deliver(renovacao.id, 'PAYMENT_OVERDUE'); // aviso atrasado

      expect(h.sub().status).toBe('active'); // o status real no Asaas manda
      await expect(h.blocked()).resolves.toBe(false);
    });

    it('webhook nunca entregue: o cron concilia pela assinatura e renova', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      h.advanceDays(31);
      const renovacao = h.renewalPayment();
      h.asaas.setStatus(renovacao.id, 'RECEIVED'); // pago, sem webhook

      await h.tick();

      expect(h.db.charges.some((c) => c.asaasPaymentId === renovacao.id)).toBe(true);
      expect(h.sub().status).toBe('active');
      expect((h.sub().currentPeriodEnd as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it('Asaas fora do ar na hora do evento: a fila reprocessa e ativa depois', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      const pay = h.asaas.last().id;
      h.asaas.setStatus(pay, 'RECEIVED');

      // Evento chega, mas o Asaas não responde → fica na fila.
      const original = h.asaas.payments;
      h.asaas.payments = [];
      await h.deliver(pay, 'PAYMENT_RECEIVED');
      expect(h.db.events[0].status).toBe('failed');
      expect(h.sub().status).not.toBe('active');

      // Provedor volta; o cron drena a fila.
      h.asaas.payments = original;
      h.advanceDays(1);
      await h.scheduler.drainWebhookQueue(new Date());

      expect(h.db.events[0].status).toBe('processed');
      expect(h.sub().status).toBe('active');
    });

    it('estorno depois de pago: cobrança marcada, acesso preservado e alerta emitido', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      const pay = h.asaas.last().id;
      await h.pay(pay);

      h.asaas.setStatus(pay, 'REFUNDED');
      await h.deliver(pay, 'PAYMENT_REFUNDED');

      expect(h.db.charges[0].status).toBe('refunded');
      expect(h.sub().status).toBe('active'); // decisão de produto: não corta na hora
      await expect(h.blocked()).resolves.toBe(false);
      expect(h.mailer.sendBillingOpsAlert).toHaveBeenCalled();
    });

    it('pagou e a ativação não completou: a empresa se cura sozinha (B18)', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      const charge = h.db.charges[0];

      // Simula a queda entre "marcar pago" e "ativar".
      charge.status = 'paid';
      charge.paidAt = new Date();
      h.db.sub.status = 'readonly';
      await expect(h.blocked()).resolves.toBe(true);

      await h.tick();

      expect(h.sub().status).toBe('active');
      expect(h.sub().currentPeriodEnd).toEqual(charge.periodEnd);
      await expect(h.blocked()).resolves.toBe(false);
    });

    it('somente-leitura manual: a empresa segue usando, e devolver destrava (R20/R44)', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      await expect(h.mode()).resolves.toBe('ok');

      h.db.sub.superadminLocked = true;
      await expect(h.mode()).resolves.toBe('read_only');

      // Suspensão é outro estado, mais duro, e independe da cobrança.
      h.db.sub.accessSuspended = true;
      await expect(h.mode()).resolves.toBe('suspended');

      h.db.sub.accessSuspended = false;
      h.db.sub.superadminLocked = false;
      await expect(h.mode()).resolves.toBe('ok');
    });

    it('trava do superadmin vence o pagamento e a cura automática', async () => {
      const h = makeHarness();
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      h.db.sub.superadminLocked = true;
      h.db.sub.status = 'readonly';

      await h.pay(h.asaas.last().id);
      await h.tick();

      expect(h.sub().status).toBe('readonly');
      await expect(h.blocked()).resolves.toBe(true);
    });

    it('maratona: trial → anual → assentos → vencimento → mensal → carência → cancelamento', async () => {
      const h = makeHarness();
      startTrial(h);

      // 1. Assina o anual no fim do trial.
      h.advanceDays(6);
      await h.service.subscribeAnnualPix(COMPANY);
      await h.pay(h.asaas.last().id);
      expect(h.sub().status).toBe('active');

      // 2. Cresce: compra 2 assentos no meio do ano.
      h.advanceDays(120);
      await h.service.buySeats(COMPANY, { quantity: 2, paymentKind: 'pix' });
      await h.pay(h.asaas.last().id);
      // No anual os usuários extras viram assinatura própria: contam por `addonSeats`.
      expect(h.sub().addonSeats).toBe(2);

      // 3. Deixa vencer o ano: a renovação da assinatura anual não é paga → carência
      //    → somente-leitura.
      h.advanceDays(250);
      const renovacaoAnual = h.renewalPayment();
      h.asaas.setStatus(renovacaoAnual.id, 'OVERDUE');
      await h.deliver(renovacaoAnual.id, 'PAYMENT_OVERDUE');
      h.advanceDays(4);
      await h.tick();
      await expect(h.blocked()).resolves.toBe(true);

      // 4. Volta no mensal. Os 2 usuários extras foram pagos por um ano e continuam
      //    valendo nas assinaturas próprias deles — a mensalidade cobre só o plano.
      await h.service.subscribeMonthly(COMPANY, {});
      await h.pagarCheckoutAberto();
      expect(h.sub().status).toBe('active');
      expect(h.recurringValue()).toBe(49.9);
      expect((await h.service.getStatus(COMPANY)).purchasedSeats).toBe(3); // 1 + 2 avulsos

      // 5. Cresce o plano e reduz de volta; a renovação seguinte falha.
      h.setMembers(2);
      await h.service.buySeats(COMPANY, { quantity: 1 });
      await h.pagarCheckoutAberto();
      await h.service.reduceSeats(COMPANY, { quantity: 1 });
      h.advanceDays(31);
      const renovacao = h.renewalPayment();
      h.asaas.setStatus(renovacao.id, 'OVERDUE');
      await h.deliver(renovacao.id, 'PAYMENT_OVERDUE');
      expect(h.sub().status).toBe('past_due');
      await expect(h.blocked()).resolves.toBe(false);

      // 6. Paga dentro da carência: volta a ativo já com 2 assentos.
      await h.pay(renovacao.id);
      expect(h.sub().status).toBe('active');
      // O plano voltou a 1 assento; os 2 avulsos anuais seguem valendo à parte.
      expect(h.sub().purchasedSeats).toBe(1);
      expect((await h.service.getStatus(COMPANY)).purchasedSeats).toBe(3);

      // 7. Cancela e acompanha até o fim do ciclo pago.
      await h.service.cancel(COMPANY);
      h.advanceDays(31);
      await h.tick();
      expect(h.sub().status).toBe('canceled');
      await expect(h.blocked()).resolves.toBe(true);

      // Nenhuma cobrança ficou pendurada sem desfecho.
      expect(h.db.charges.filter((c) => c.status === 'pending')).toHaveLength(0);
    });
  });

  // ── Calendário ───────────────────────────────────────────────────────────

  describe('bordas de calendário', () => {
    it('ciclo iniciado em 31 de janeiro renova em fevereiro sem estourar o mês', async () => {
      const h = makeHarness();
      h.travelTo(new Date('2026-01-31T12:00:00Z'));
      await subscribedMonthly(h);
      const fim = h.sub().currentPeriodEnd as Date;
      expect(format(fim, 'yyyy-MM-dd')).toBe('2026-02-28');
    });

    it('assinatura anual comprada em ano bissexto vence no ano seguinte', async () => {
      const h = makeHarness();
      h.travelTo(new Date('2028-02-29T12:00:00Z'));
      startTrial(h);
      await h.service.subscribeAnnualPix(COMPANY);
      await h.pay(h.asaas.last().id);
      expect(format(h.sub().currentPeriodEnd as Date, 'yyyy-MM-dd')).toBe('2029-02-28');
    });

    it('pagamento no último instante do ciclo mantém a empresa ativa (sem buraco)', async () => {
      const h = makeHarness();
      await subscribedMonthly(h);
      const fim = h.sub().currentPeriodEnd as Date;

      h.travelTo(new Date(fim.getTime() - 1000));
      await h.tick();
      await expect(h.blocked()).resolves.toBe(false);

      await h.pay(h.renewalPayment().id);
      expect((h.sub().currentPeriodEnd as Date).getTime()).toBeGreaterThan(fim.getTime());
    });
  });
});
