import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { BillingAccessService } from '../billing-access.service';
import { SKIP_BILLING_GATE_KEY } from '../decorators/skip-billing-gate.decorator';
import { BillingGateGuard } from './billing-gate.guard';

function makeCtx(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

const config = (enabled = true) =>
  ({ get: () => (enabled ? 'true' : 'false') }) as unknown as ConfigService;

const reflector = (skip = false, pub = false) =>
  ({
    getAllAndOverride: (key: string) =>
      key === SKIP_BILLING_GATE_KEY ? skip : key === IS_PUBLIC_KEY ? pub : undefined,
  }) as unknown as Reflector;

const access = (
  mode: 'ok' | 'read_only' | 'suspended',
  blockReason: string | null = 'subscription_expired',
) =>
  ({
    getSummary: jest.fn().mockResolvedValue({
      status: mode === 'ok' ? 'active' : 'readonly',
      mode,
      blocked: mode !== 'ok',
      blockReason: mode === 'ok' ? null : blockReason,
      needsSubscription: false,
      trialEndsAt: null,
    }),
    invalidate: jest.fn(),
  }) as unknown as BillingAccessService;

const prisma = (companyId: string | null = null) =>
  ({
    workspace: { findUnique: jest.fn().mockResolvedValue(companyId ? { companyId } : null) },
    project: {
      findUnique: jest.fn().mockResolvedValue(companyId ? { workspace: { companyId } } : null),
    },
  }) as unknown as PrismaService;

const member = { id: 'u1', isSuperuser: false } as const;

describe('BillingGateGuard', () => {
  it('libera leituras (GET) mesmo com empresa bloqueada', async () => {
    const guard = new BillingGateGuard(reflector(), access('read_only'), prisma(), config());
    const ok = await guard.canActivate(
      makeCtx({ method: 'GET', user: member, params: { companyId: 'c1' } }),
    );
    expect(ok).toBe(true);
  });

  it('com a cobrança desligada o estado vem do resumo (que devolve `ok`)', async () => {
    // A trava manual e a suspensão são decisões do superusuário e valem mesmo com
    // `BILLING_ENABLED=false` — quem decide é o `mode`, não a env.
    const guard = new BillingGateGuard(reflector(), access('ok'), prisma(), config(false));
    const ok = await guard.canActivate(
      makeCtx({ method: 'POST', user: member, params: { companyId: 'c1' } }),
    );
    expect(ok).toBe(true);
  });

  it('libera rotas com @SkipBillingGate', async () => {
    const guard = new BillingGateGuard(reflector(true), access('read_only'), prisma(), config());
    const ok = await guard.canActivate(
      makeCtx({ method: 'POST', user: member, params: { companyId: 'c1' } }),
    );
    expect(ok).toBe(true);
  });

  it('libera superusuário', async () => {
    const guard = new BillingGateGuard(reflector(), access('read_only'), prisma(), config());
    const ok = await guard.canActivate(
      makeCtx({
        method: 'POST',
        user: { id: 's', isSuperuser: true },
        params: { companyId: 'c1' },
      }),
    );
    expect(ok).toBe(true);
  });

  it('libera quando não há escopo de empresa resolvível', async () => {
    const guard = new BillingGateGuard(reflector(), access('read_only'), prisma(), config());
    const ok = await guard.canActivate(makeCtx({ method: 'POST', user: member, params: {} }));
    expect(ok).toBe(true);
  });

  it('libera quando não há usuário (rota pública)', async () => {
    const guard = new BillingGateGuard(reflector(), access('read_only'), prisma(), config());
    const ok = await guard.canActivate(
      makeCtx({ method: 'POST', user: undefined, params: { companyId: 'c1' } }),
    );
    expect(ok).toBe(true);
  });

  it('bloqueia mutação de empresa bloqueada com code COMPANY_BLOCKED + reason', async () => {
    const guard = new BillingGateGuard(
      reflector(),
      access('read_only', 'trial_ended'),
      prisma(),
      config(),
    );
    await expect(
      guard.canActivate(makeCtx({ method: 'POST', user: member, params: { companyId: 'c1' } })),
    ).rejects.toMatchObject({ response: { code: 'COMPANY_BLOCKED', reason: 'trial_ended' } });
  });

  it('libera mutação de empresa ativa', async () => {
    const guard = new BillingGateGuard(reflector(), access('ok'), prisma(), config());
    const ok = await guard.canActivate(
      makeCtx({ method: 'PATCH', user: member, params: { companyId: 'c1' } }),
    );
    expect(ok).toBe(true);
  });

  it('resolve a empresa pelo workspaceId e bloqueia criação', async () => {
    const guard = new BillingGateGuard(
      reflector(),
      access('read_only'),
      prisma('c-from-ws'),
      config(),
    );
    await expect(
      guard.canActivate(makeCtx({ method: 'POST', user: member, params: { workspaceId: 'w1' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── R20/R44: a tabela de verbos ─────────────────────────────────────────────

  describe('somente-leitura: usa o sistema, sem produzir', () => {
    for (const verbo of ['GET', 'HEAD', 'OPTIONS', 'DELETE']) {
      it(`libera ${verbo}`, async () => {
        const guard = new BillingGateGuard(reflector(), access('read_only'), prisma(), config());
        await expect(
          guard.canActivate(makeCtx({ method: verbo, user: member, params: { companyId: 'c1' } })),
        ).resolves.toBe(true);
      });
    }

    for (const verbo of ['POST', 'PUT', 'PATCH']) {
      it(`bloqueia ${verbo}`, async () => {
        const guard = new BillingGateGuard(reflector(), access('read_only'), prisma(), config());
        await expect(
          guard.canActivate(makeCtx({ method: verbo, user: member, params: { companyId: 'c1' } })),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    }
  });

  describe('suspensa: porta fechada', () => {
    for (const verbo of ['GET', 'DELETE', 'POST', 'PATCH']) {
      it(`bloqueia ${verbo}`, async () => {
        const guard = new BillingGateGuard(
          reflector(),
          access('suspended', 'admin_suspended'),
          prisma(),
          config(),
        );
        await expect(
          guard.canActivate(makeCtx({ method: verbo, user: member, params: { companyId: 'c1' } })),
        ).rejects.toMatchObject({ response: { reason: 'admin_suspended' } });
      });
    }

    it('cobrança e exportação seguem acessíveis (@SkipBillingGate)', async () => {
      const guard = new BillingGateGuard(reflector(true), access('suspended'), prisma(), config());
      await expect(
        guard.canActivate(makeCtx({ method: 'GET', user: member, params: { companyId: 'c1' } })),
      ).resolves.toBe(true);
    });
  });

  it('resolve a empresa pelo projectId', async () => {
    const guard = new BillingGateGuard(reflector(), access('ok'), prisma('c-from-proj'), config());
    const ok = await guard.canActivate(
      makeCtx({ method: 'POST', user: member, params: { projectId: 'p1' } }),
    );
    expect(ok).toBe(true);
  });
});
