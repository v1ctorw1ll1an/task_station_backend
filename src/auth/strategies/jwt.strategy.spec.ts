import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { AuthRepository } from '../auth.repository';
import { JwtStrategy, JwtPayload } from './jwt.strategy';

function makeConfig(secret = 'test-secret'): ConfigService {
  return {
    getOrThrow: jest.fn().mockReturnValue(secret),
  } as unknown as ConfigService;
}

const USER = {
  id: 'u-1',
  email: 'a@x.com',
  isSuperuser: true,
  mustResetPassword: false,
  isActive: true,
  activeSessionId: 'sess-atual',
};

function makeRepo(user: Record<string, unknown> | null = USER): AuthRepository {
  return {
    findActiveUserById: jest.fn().mockResolvedValue(user),
  } as unknown as AuthRepository;
}

const payload = (over: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'u-1',
  email: 'a@x.com',
  isSuperuser: true,
  mustResetPassword: false,
  sid: 'sess-atual',
  ...over,
});

describe('JwtStrategy', () => {
  it('constructor lê JWT_SECRET via ConfigService.getOrThrow', () => {
    const config = makeConfig('seg-1');
    new JwtStrategy(config, makeRepo());
    expect(config.getOrThrow).toHaveBeenCalledWith('JWT_SECRET');
  });

  it('constructor lança quando JWT_SECRET ausente', () => {
    const config = {
      getOrThrow: jest.fn().mockImplementation(() => {
        throw new Error('Missing JWT_SECRET');
      }),
    } as unknown as ConfigService;
    expect(() => new JwtStrategy(config, makeRepo())).toThrow('Missing JWT_SECRET');
  });

  it('sessão vigente passa e devolve o usuário do banco', async () => {
    const strategy = new JwtStrategy(makeConfig(), makeRepo());
    await expect(strategy.validate(payload())).resolves.toEqual({
      id: 'u-1',
      email: 'a@x.com',
      isSuperuser: true,
      mustResetPassword: false,
    });
  });

  it('reflete o estado atual do usuário, não o do token', async () => {
    // Token emitido antes da troca de senha ainda diz `false`; o banco manda.
    const strategy = new JwtStrategy(makeConfig(), makeRepo({ ...USER, mustResetPassword: true }));
    const result = await strategy.validate(payload({ mustResetPassword: false }));
    expect(result.mustResetPassword).toBe(true);
  });

  // ── Um assento = um login ────────────────────────────────────────────────

  it('sessão substituída por login em outro dispositivo é recusada', async () => {
    const strategy = new JwtStrategy(makeConfig(), makeRepo({ ...USER, activeSessionId: 'nova' }));
    await expect(strategy.validate(payload({ sid: 'antiga' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await strategy.validate(payload({ sid: 'antiga' })).catch((err: UnauthorizedException) => {
      expect(err.getResponse()).toMatchObject({ code: 'SESSION_REPLACED' });
    });
  });

  it('logout (sem sessão ativa) não derruba token ainda válido', async () => {
    // `activeSessionId` nulo = ninguém logado; o token segue até expirar. Quem
    // corta o acesso de fato é o logout no cliente + a expiração.
    const strategy = new JwtStrategy(makeConfig(), makeRepo({ ...USER, activeSessionId: null }));
    await expect(strategy.validate(payload({ sid: 'qualquer' }))).resolves.toMatchObject({
      id: 'u-1',
    });
  });

  it('token antigo, emitido sem `sid`, continua valendo até expirar', async () => {
    const strategy = new JwtStrategy(makeConfig(), makeRepo());
    const semSid = payload();
    delete semSid.sid;
    await expect(strategy.validate(semSid)).resolves.toMatchObject({ id: 'u-1' });
  });

  it('usuário desativado perde acesso na hora, sem esperar o token expirar', async () => {
    const strategy = new JwtStrategy(makeConfig(), makeRepo({ ...USER, isActive: false }));
    await expect(strategy.validate(payload())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('usuário excluído é recusado', async () => {
    const strategy = new JwtStrategy(makeConfig(), makeRepo(null));
    await expect(strategy.validate(payload())).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
