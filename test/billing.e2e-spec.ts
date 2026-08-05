import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import crypto from 'crypto';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { AsaasClient } from './../src/billing/asaas/asaas.client';
import { BillingAccessService } from './../src/billing/billing-access.service';
import { BillingSchedulerService } from './../src/billing/billing-scheduler.service';
import { BillingWebhookService } from './../src/billing/billing-webhook.service';
import { MailerService } from './../src/mailer/mailer.service';
import { PrismaService } from './../src/prisma/prisma.service';

jest.setTimeout(60_000);

const WEBHOOK_TOKEN = 'e2e-token';

const b64 = (x: string) => Buffer.from(x).toString('base64url');
function mintJwt(secret: string, sub: string, email: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(
    JSON.stringify({
      sub,
      email,
      isSuperuser: false,
      mustResetPassword: false,
      iat: now,
      exp: now + 3600,
    }),
  );
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

describe('Billing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let access: BillingAccessService;
  /**
   * Asaas dublê. Com o checkout hospedado, a superfície que o app usa cresceu: o
   * `createCheckout` é o caminho de todo pagamento com cartão e o `listPayments` é como
   * o "Já paguei" encontra a cobrança que o checkout gerou.
   */
  const asaasMock = {
    getPayment: jest.fn(),
    createCustomer: jest.fn().mockResolvedValue({ id: 'cus_e2e' }),
    updateCustomer: jest.fn().mockResolvedValue({ id: 'cus_e2e' }),
    createCheckout: jest
      .fn()
      .mockResolvedValue({ id: 'chk_e2e', link: 'https://asaas.test/chk_e2e', status: 'ACTIVE' }),
    cancelCheckout: jest.fn().mockResolvedValue({ id: 'chk_e2e', status: 'CANCELED' }),
    createSubscription: jest.fn().mockResolvedValue({ id: 'asub_e2e', status: 'ACTIVE' }),
    deleteSubscription: jest.fn().mockResolvedValue({ deleted: true }),
    updateSubscriptionValue: jest.fn().mockResolvedValue({}),
    listCustomerSubscriptions: jest.fn().mockResolvedValue({ data: [] }),
    listSubscriptionPayments: jest.fn().mockResolvedValue({ data: [] }),
    listPayments: jest.fn().mockResolvedValue({ data: [] }),
    createPayment: jest.fn().mockResolvedValue({ id: 'pay_e2e', invoiceUrl: 'http://inv' }),
    getPixQrCode: jest.fn().mockResolvedValue({
      encodedImage: 'img',
      payload: '000201',
      expirationDate: '2099-12-31 23:59:59',
    }),
  };
  // Nenhum e-mail real sai daqui (o fluxo de pagamento confirmado dispara aviso).
  const mailerMock = {
    sendPaymentConfirmedEmail: jest.fn().mockResolvedValue(undefined),
    sendPaymentFailedEmail: jest.fn().mockResolvedValue(undefined),
    sendSeatPixEmail: jest.fn().mockResolvedValue(undefined),
    sendBillingOpsAlert: jest.fn().mockResolvedValue(undefined),
    sendTrialEndingEmail: jest.fn().mockResolvedValue(undefined),
    sendTrialEndedEmail: jest.fn().mockResolvedValue(undefined),
    sendReadOnlyActivatedEmail: jest.fn().mockResolvedValue(undefined),
    sendAnnualRenewalReminderEmail: jest.fn().mockResolvedValue(undefined),
  };

  let companyId: string;
  let userId: string;
  let adminJwt: string;

  beforeAll(async () => {
    process.env.BILLING_ENABLED = 'true';
    process.env.ASAAS_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
    process.env.ASAAS_API_URL = process.env.ASAAS_API_URL ?? 'http://asaas.mock';
    process.env.ASAAS_API_KEY = process.env.ASAAS_API_KEY ?? 'e2e-key';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AsaasClient)
      .useValue(asaasMock)
      .overrideProvider(MailerService)
      .useValue(mailerMock)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();

    prisma = app.get(PrismaService);
    access = app.get(BillingAccessService);

    const suffix = Date.now();
    const user = await prisma.user.create({
      data: {
        email: `e2e-admin-${suffix}@test.com`,
        passwordHash: 'x',
        name: 'E2E Admin',
        mustResetPassword: false,
      },
    });
    userId = user.id;
    const company = await prisma.company.create({
      data: { legalName: 'E2E Co', taxId: `e2e-${suffix}`, createdById: userId },
    });
    companyId = company.id;
    await prisma.membership.create({
      data: { userId, resourceType: 'company', resourceId: companyId, role: 'admin' },
    });
    await prisma.subscription.create({ data: { companyId, status: 'active', purchasedSeats: 1 } });

    adminJwt = mintJwt(process.env.JWT_SECRET as string, userId, user.email);
  });

  afterAll(async () => {
    await prisma.webhookEvent
      .deleteMany({ where: { asaasEventId: { startsWith: 'e2e-' } } })
      .catch(() => {});
    await prisma.membership.deleteMany({ where: { resourceId: companyId } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {}); // cascata: subscription + charges
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await app.close();
  });

  async function setStatus(status: string) {
    await prisma.subscription.update({ where: { companyId }, data: { status: status as never } });
    access.invalidate(companyId); // sem esperar o TTL de 30s
  }

  describe('Webhook', () => {
    it('rejeita sem o token (401)', () =>
      request(app.getHttpServer())
        .post('/api/v1/billing/webhook')
        .send({ id: 'e2e-nokey', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_x' } })
        .expect(401));

    it('rejeita token errado (401)', () =>
      request(app.getHttpServer())
        .post('/api/v1/billing/webhook')
        .set('asaas-access-token', 'errado')
        .send({ id: 'e2e-bad', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_x' } })
        .expect(401));

    it('token certo → 200 e registra o evento', async () => {
      asaasMock.getPayment.mockResolvedValue({ id: 'pay_x', status: 'PENDING' });
      await request(app.getHttpServer())
        .post('/api/v1/billing/webhook')
        .set('asaas-access-token', WEBHOOK_TOKEN)
        .send({ id: 'e2e-evt-1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_x' } })
        .expect(200)
        .expect({ received: true, result: 'ok' });

      const row = await prisma.webhookEvent.findUnique({ where: { asaasEventId: 'e2e-evt-1' } });
      expect(row).toBeTruthy();
    });

    it('é idempotente: reenvio do mesmo evento não duplica', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/billing/webhook')
        .set('asaas-access-token', WEBHOOK_TOKEN)
        .send({ id: 'e2e-evt-1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_x' } })
        .expect(200)
        .expect({ received: true, result: 'duplicate' });

      const count = await prisma.webhookEvent.count({ where: { asaasEventId: 'e2e-evt-1' } });
      expect(count).toBe(1);
    });

    // B1: falha de PROCESSAMENTO não pode "encerrar" o evento — ele fica na fila
    // local com nova tentativa agendada, e o Asaas recebe 200 (já está gravado).
    it('falha ao processar → 200, evento em `failed` com retentativa agendada', async () => {
      asaasMock.getPayment.mockRejectedValueOnce(new Error('asaas indisponível'));
      await request(app.getHttpServer())
        .post('/api/v1/billing/webhook')
        .set('asaas-access-token', WEBHOOK_TOKEN)
        .send({ id: 'e2e-evt-fail', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_y' } })
        .expect(200);

      const row = await prisma.webhookEvent.findUnique({
        where: { asaasEventId: 'e2e-evt-fail' },
      });
      expect(row?.status).toBe('failed');
      expect(row?.attempts).toBe(1);
      expect(row?.nextAttemptAt).toBeTruthy();
    });
  });

  /**
   * O ciclo completo do B1 com banco de verdade: o evento chega enquanto o Asaas
   * está fora, não é dado por encerrado, e o cron o recupera depois — o cliente que
   * pagou acaba ativado sem ninguém mexer em nada.
   */
  describe('Recuperação de webhook (B1 — ponta a ponta)', () => {
    it('Asaas fora no evento → fila local → cron drena → assinatura ativa', async () => {
      const sub = await prisma.subscription.update({
        where: { companyId },
        data: { status: 'readonly', method: 'annual_pix' },
      });
      access.invalidate(companyId);

      const paymentId = `e2e-pay-${Date.now()}`;
      const charge = await prisma.billingCharge.create({
        data: {
          subscriptionId: sub.id,
          companyId,
          type: 'subscription',
          paymentKind: 'pix',
          status: 'pending',
          amountCents: 43092,
          installments: 1,
          seats: 1,
          asaasPaymentId: paymentId,
        },
      });

      // 1) Evento chega com o provedor indisponível: respondemos 200 (já está gravado)
      //    e o processamento vai para a fila em vez de se perder.
      asaasMock.getPayment.mockRejectedValueOnce(new Error('asaas fora do ar'));
      await request(app.getHttpServer())
        .post('/api/v1/billing/webhook')
        .set('asaas-access-token', WEBHOOK_TOKEN)
        .send({ id: 'e2e-recover', event: 'PAYMENT_RECEIVED', payment: { id: paymentId } })
        .expect(200);

      const queued = await prisma.webhookEvent.findUnique({
        where: { asaasEventId: 'e2e-recover' },
      });
      expect(queued).toMatchObject({ status: 'failed', attempts: 1 });
      expect((await prisma.subscription.findUnique({ where: { companyId } }))?.status).toBe(
        'readonly',
      );

      // 2) Asaas volta; o cron drena a fila (relógio adiantado além do backoff).
      asaasMock.getPayment.mockResolvedValue({
        id: paymentId,
        status: 'RECEIVED',
        value: 430.92,
      });
      await app.get(BillingSchedulerService).drainWebhookQueue(new Date(Date.now() + 10 * 60_000));

      const done = await prisma.webhookEvent.findUnique({ where: { asaasEventId: 'e2e-recover' } });
      expect(done).toMatchObject({ status: 'processed', nextAttemptAt: null });
      expect((await prisma.billingCharge.findUnique({ where: { id: charge.id } }))?.status).toBe(
        'paid',
      );
      expect((await prisma.subscription.findUnique({ where: { companyId } }))?.status).toBe(
        'active',
      );
      // R24: o gate já enxerga a empresa liberada, sem esperar TTL de cache.
      await expect(access.isBlocked(companyId)).resolves.toBe(false);
    });

    it('reprocessar um evento já aplicado não cobra nem ativa de novo (idempotência)', async () => {
      const before = await prisma.subscription.findUnique({ where: { companyId } });
      const event = await prisma.webhookEvent.findUnique({
        where: { asaasEventId: 'e2e-recover' },
      });

      await app.get(BillingSchedulerService).drainWebhookQueue(new Date(Date.now() + 60 * 60_000));
      // Já está `processed` → fora da fila; e um reprocesso manual é inofensivo.
      await app.get(BillingWebhookService).reprocess({
        id: event!.id,
        type: event!.type,
        payload: event!.payload,
        attempts: 0,
      });

      const charges = await prisma.billingCharge.count({ where: { companyId, status: 'paid' } });
      expect(charges).toBe(1);
      const after = await prisma.subscription.findUnique({ where: { companyId } });
      expect(after?.status).toBe('active');
      expect(after?.purchasedSeats).toBe(before?.purchasedSeats);
    });
  });

  /**
   * Somente-leitura (R20): a empresa bloqueada continua consultando tudo e perde só
   * a escrita — e a saída dos dados nunca é fechada (R42).
   */
  describe('Exportação (disponível mesmo bloqueada)', () => {
    it('JSON com o acervo da empresa, com nome de arquivo', async () => {
      await setStatus('readonly');
      const res = await request(app.getHttpServer())
        .get(`/api/v1/billing/empresa/${companyId}/exportar`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);

      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['content-disposition']).toContain('attachment; filename=');
      const corpo = JSON.parse(res.text) as { empresa: { legalName: string } };
      expect(corpo.empresa.legalName).toBe('E2E Co');
    });

    it('CSV para abrir em planilha', async () => {
      await setStatus('readonly');
      const res = await request(app.getHttpServer())
        .get(`/api/v1/billing/empresa/${companyId}/exportar?formato=csv`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text.split('\n')[0]).toContain('workspace,projeto,coluna');
    });
  });

  /**
   * A tabela de verbos (R20/R44) contra a API de verdade — é o contrato que
   * sustenta "usar o sistema sem produzir".
   */
  describe('Somente-leitura x suspensão (por verbo)', () => {
    async function suspender(suspended: boolean) {
      await prisma.subscription.update({
        where: { companyId },
        data: { accessSuspended: suspended },
      });
      access.invalidate(companyId);
    }

    // Teste que falha no meio não pode deixar a empresa travada para os seguintes.
    afterEach(async () => {
      await prisma.subscription.update({
        where: { companyId },
        data: { accessSuspended: false, superadminLocked: false },
      });
      access.invalidate(companyId);
    });

    it('em somente-leitura: GET passa, POST é barrado', async () => {
      await setStatus('readonly');
      await request(app.getHttpServer())
        .get(`/api/v1/empresa/${companyId}/workspaces`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/empresa/${companyId}/workspaces`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({})
        .expect(403);
      expect((res.body as { code?: string }).code).toBe('COMPANY_BLOCKED');
    });

    it('em somente-leitura: DELETE passa pelo gate (404 do recurso, não 403)', async () => {
      await setStatus('readonly');
      await request(app.getHttpServer())
        .delete(`/api/v1/empresa/${companyId}/workspaces/00000000-0000-0000-0000-000000000000`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(404);
    });

    it('suspensa: nem leitura, mas cobrança e exportação continuam', async () => {
      await setStatus('readonly');
      await suspender(true);

      await request(app.getHttpServer())
        .get(`/api/v1/empresa/${companyId}/workspaces`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/api/v1/empresa/${companyId}/workspaces/00000000-0000-0000-0000-000000000000`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(403);

      await request(app.getHttpServer())
        .get(`/api/v1/billing/empresa/${companyId}`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/billing/empresa/${companyId}/exportar`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
    });

    it('trava manual do superadmin deixa o app utilizável (não é suspensão)', async () => {
      await prisma.subscription.update({
        where: { companyId },
        data: { status: 'active', superadminLocked: true },
      });
      access.invalidate(companyId);

      await request(app.getHttpServer())
        .get(`/api/v1/empresa/${companyId}/workspaces`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/empresa/${companyId}/workspaces`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({})
        .expect(403);
      expect((res.body as { reason?: string }).reason).toBe('admin_locked');
    });
  });

  describe('Gate de escrita', () => {
    it('empresa bloqueada → mutação 403 COMPANY_BLOCKED', async () => {
      await setStatus('readonly');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/empresa/${companyId}/workspaces`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({})
        .expect(403);
      expect((res.body as { code?: string }).code).toBe('COMPANY_BLOCKED');
    });

    it('leitura não é bloqueada mesmo em somente-leitura (200)', async () => {
      await setStatus('readonly');
      await request(app.getHttpServer())
        .get(`/api/v1/empresa/${companyId}/workspaces`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
    });

    it('empresa ativa → mutação passa o gate (400 de validação, não 403)', async () => {
      await setStatus('active');
      await request(app.getHttpServer())
        .post(`/api/v1/empresa/${companyId}/workspaces`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({})
        .expect(400);
    });
  });
});
