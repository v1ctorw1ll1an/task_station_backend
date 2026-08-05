import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { AsaasClient } from './../src/billing/asaas/asaas.client';
import { PrismaService } from './../src/prisma/prisma.service';
import { TRIAL_SEATS } from './../src/billing/billing.constants';

jest.setTimeout(60_000);

describe('Auth register / self-signup (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const asaasMock = { getPayment: jest.fn() };

  const suffix = Date.now();
  // O DTO valida dígito verificador (@IsCpfCnpj), então não basta ter 14 dígitos:
  // um número qualquer volta 400. A base varia por execução para o CNPJ ser único.
  const cnpjValido = (base12: string) => {
    const dv = (digits: string, pesos: number[]) => {
      const resto = digits.split('').reduce((acc, c, i) => acc + Number(c) * pesos[i], 0) % 11;
      return resto < 2 ? 0 : 11 - resto;
    };
    const dv1 = dv(base12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    const dv2 = dv(`${base12}${dv1}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return `${base12}${dv1}${dv2}`;
  };
  const taxId = cnpjValido(`2${suffix}`.slice(0, 12));
  const offTaxId = cnpjValido(`3${suffix}`.slice(0, 12));
  const email = `e2e-signup-${suffix}@test.com`;

  beforeAll(async () => {
    process.env.PUBLIC_SIGNUP_ENABLED = 'true';
    process.env.ASAAS_API_URL = process.env.ASAAS_API_URL ?? 'http://asaas.mock';
    process.env.ASAAS_API_KEY = process.env.ASAAS_API_KEY ?? 'e2e-key';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AsaasClient)
      .useValue(asaasMock)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // Limpa tudo o que o cadastro tenha criado (empresa → cascata subscription).
    const company = await prisma.company.findFirst({ where: { taxId } }).catch(() => null);
    if (company) {
      await prisma.membership.deleteMany({ where: { resourceId: company.id } }).catch(() => {});
      await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
    }
    const user = await prisma.user.findFirst({ where: { email } }).catch(() => null);
    if (user) {
      await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    }
    await app.close();
  });

  it('flag desligada → 404 (rota não existe)', async () => {
    process.env.PUBLIC_SIGNUP_ENABLED = 'false';
    try {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          legalName: 'Off Co',
          taxId: offTaxId,
          ownerName: 'Zé',
          email: `off-${suffix}@t.com`,
          phone: '11987654321',
        })
        .expect(404);
    } finally {
      process.env.PUBLIC_SIGNUP_ENABLED = 'true';
    }
  });

  it('cadastro válido → 201, cria assinatura trial (7d) e token de primeiro acesso', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        legalName: 'E2E Signup Co',
        taxId,
        ownerName: 'Maria Dona',
        email,
        phone: '(11) 98765-4321',
      })
      .expect(201)
      .expect({ ok: true });

    const company = await prisma.company.findFirst({ where: { taxId } });
    expect(company).toBeTruthy();

    const sub = await prisma.subscription.findUnique({ where: { companyId: company!.id } });
    expect(sub?.status).toBe('trial');
    expect(sub?.purchasedSeats).toBe(TRIAL_SEATS);
    const days = (sub!.trialEndsAt!.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(6.5);
    expect(days).toBeLessThan(7.5);

    // dono = admin da empresa + tem token de primeiro acesso pendente
    const owner = await prisma.user.findFirst({ where: { email } });
    expect(owner?.mustResetPassword).toBe(true);
    // Telefone entrou mascarado no request e tem que estar gravado só com dígitos.
    expect(owner?.phone).toBe('11987654321');
    const membership = await prisma.membership.findFirst({
      where: { userId: owner!.id, resourceType: 'company', resourceId: company!.id, role: 'admin' },
    });
    expect(membership).toBeTruthy();
    const token = await prisma.passwordResetToken.findFirst({
      where: { userId: owner!.id, type: 'first_access', usedAt: null },
    });
    expect(token).toBeTruthy();
  });

  it('CNPJ já cadastrado → 409', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        legalName: 'Outra Co',
        taxId,
        ownerName: 'Outro',
        email: `outro-${suffix}@t.com`,
        phone: '11987654321',
      })
      .expect(409);
  });
});
