import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiTokenService } from '../../api-token/api-token.service';
import { JwtAuthGuard } from './jwt-auth.guard';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeReflector(getAllAndOverride: jest.Mock = jest.fn()): Reflector {
  return { getAllAndOverride } as unknown as Reflector;
}

function makeApiTokens(authenticate: jest.Mock = jest.fn()): ApiTokenService {
  return { authenticate } as unknown as ApiTokenService;
}

function makeContext(
  request: Record<string, unknown> = { headers: {} },
  type = 'http',
): ExecutionContext {
  return {
    getHandler: jest.fn().mockReturnValue('handler'),
    getClass: jest.fn().mockReturnValue('class'),
    getType: jest.fn().mockReturnValue(type),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function spyOnPassport(result: boolean) {
  return jest
    .spyOn(
      Object.getPrototypeOf(JwtAuthGuard.prototype) as { canActivate: () => boolean },
      'canActivate',
    )
    .mockReturnValue(result);
}

// ── canActivate ────────────────────────────────────────────────────────────────

describe('JwtAuthGuard.canActivate', () => {
  afterEach(() => jest.restoreAllMocks());

  it('retorna true quando @Public() está aplicado, sem delegar ao Passport', () => {
    const guard = new JwtAuthGuard(makeReflector(jest.fn().mockReturnValue(true)), makeApiTokens());
    const superSpy = spyOnPassport(false);

    const result = guard.canActivate(makeContext());

    expect(result).toBe(true);
    expect(superSpy).not.toHaveBeenCalled();
  });

  it('delega ao Passport (super.canActivate) quando rota não é pública', () => {
    const guard = new JwtAuthGuard(
      makeReflector(jest.fn().mockReturnValue(false)),
      makeApiTokens(),
    );
    const superSpy = spyOnPassport(true);

    const result = guard.canActivate(makeContext());

    expect(superSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it('quando reflector retorna undefined (sem decorator), delega ao Passport', () => {
    const guard = new JwtAuthGuard(
      makeReflector(jest.fn().mockReturnValue(undefined)),
      makeApiTokens(),
    );
    const superSpy = spyOnPassport(true);

    guard.canActivate(makeContext());
    expect(superSpy).toHaveBeenCalled();
  });

  it('consulta o reflector com IS_PUBLIC_KEY em handler e classe', () => {
    const getAllAndOverride = jest.fn().mockReturnValue(false);
    const guard = new JwtAuthGuard(makeReflector(getAllAndOverride), makeApiTokens());
    spyOnPassport(true);

    guard.canActivate(makeContext());

    expect(getAllAndOverride).toHaveBeenCalledWith('isPublic', ['handler', 'class']);
  });

  // ── Token de acesso pessoal (PAT) ────────────────────────────────────────────

  describe('token de acesso pessoal (tdy_)', () => {
    const user = { id: 'u-1', email: 'a@x.com', isSuperuser: false, mustResetPassword: false };
    const token = { id: 'tok-1', workspaceId: 'ws-1' };

    it('autentica pelo ApiTokenService, sem passar pelo Passport/JWT', async () => {
      const authenticate = jest.fn().mockResolvedValue({ user, token });
      const guard = new JwtAuthGuard(makeReflector(), makeApiTokens(authenticate));
      const superSpy = spyOnPassport(false);
      const request: Record<string, unknown> = {
        headers: { authorization: 'Bearer tdy_abc123' },
      };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);

      expect(authenticate).toHaveBeenCalledWith('tdy_abc123');
      expect(superSpy).not.toHaveBeenCalled();
      expect(request.user).toEqual(user);
      expect(request.apiToken).toEqual(token);
    });

    it('aceita o esquema "bearer" em qualquer caixa', async () => {
      const authenticate = jest.fn().mockResolvedValue({ user, token });
      const guard = new JwtAuthGuard(makeReflector(), makeApiTokens(authenticate));
      spyOnPassport(false);

      await guard.canActivate(makeContext({ headers: { authorization: 'bearer tdy_abc' } }));
      expect(authenticate).toHaveBeenCalledWith('tdy_abc');
    });

    it('propaga o 401 de token inválido', async () => {
      const authenticate = jest.fn().mockRejectedValue(new UnauthorizedException());
      const guard = new JwtAuthGuard(makeReflector(), makeApiTokens(authenticate));
      spyOnPassport(true);

      await expect(
        guard.canActivate(makeContext({ headers: { authorization: 'Bearer tdy_x' } })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('JWT comum continua indo para o Passport', () => {
      const authenticate = jest.fn();
      const guard = new JwtAuthGuard(makeReflector(), makeApiTokens(authenticate));
      const superSpy = spyOnPassport(true);

      guard.canActivate(makeContext({ headers: { authorization: 'Bearer eyJhbGciOi.x.y' } }));

      expect(authenticate).not.toHaveBeenCalled();
      expect(superSpy).toHaveBeenCalledTimes(1);
    });

    it('rota pública ignora o token', () => {
      const authenticate = jest.fn();
      const guard = new JwtAuthGuard(
        makeReflector(jest.fn().mockReturnValue(true)),
        makeApiTokens(authenticate),
      );

      expect(guard.canActivate(makeContext({ headers: { authorization: 'Bearer tdy_x' } }))).toBe(
        true,
      );
      expect(authenticate).not.toHaveBeenCalled();
    });

    it('fora de HTTP (websocket) não procura token de acesso', () => {
      const authenticate = jest.fn();
      const guard = new JwtAuthGuard(makeReflector(), makeApiTokens(authenticate));
      const superSpy = spyOnPassport(true);

      guard.canActivate(makeContext({ headers: { authorization: 'Bearer tdy_x' } }, 'ws'));

      expect(authenticate).not.toHaveBeenCalled();
      expect(superSpy).toHaveBeenCalled();
    });
  });
});
