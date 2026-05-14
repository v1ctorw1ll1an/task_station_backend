import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsAuthGuard } from './ws-auth.guard';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeJwt(): jest.Mocked<JwtService> {
  return { verify: jest.fn() } as unknown as jest.Mocked<JwtService>;
}

function makeConfig(secret = 'test-secret'): ConfigService {
  return {
    getOrThrow: jest.fn().mockReturnValue(secret),
  } as unknown as ConfigService;
}

function makeContext(client: Record<string, unknown>): ExecutionContext {
  return {
    switchToWs: () => ({ getClient: () => client }),
  } as unknown as ExecutionContext;
}

function makeClient(
  opts: {
    authToken?: string;
    authHeader?: string;
  } = {},
) {
  return {
    handshake: {
      auth: opts.authToken ? { token: opts.authToken } : {},
      headers: opts.authHeader ? { authorization: opts.authHeader } : {},
    },
    data: {},
    disconnect: jest.fn(),
  };
}

// ── ws-auth ────────────────────────────────────────────────────────────────────

describe('WsAuthGuard.canActivate', () => {
  it('aceita token válido vindo de handshake.auth.token e anexa user em client.data', () => {
    const jwt = makeJwt();
    jwt.verify.mockReturnValue({
      sub: 'u-1',
      email: 'a@x.com',
      isSuperuser: false,
      mustResetPassword: false,
    } as any);
    const guard = new WsAuthGuard(jwt, makeConfig('seg'));
    const client = makeClient({ authToken: 'tok-1' });

    const result = guard.canActivate(makeContext(client));

    expect(result).toBe(true);
    expect(jwt.verify).toHaveBeenCalledWith('tok-1', { secret: 'seg' });
    expect((client.data as any).user).toEqual({
      id: 'u-1',
      email: 'a@x.com',
      isSuperuser: false,
      mustResetPassword: false,
    });
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('aceita token vindo do header Authorization: Bearer <token>', () => {
    const jwt = makeJwt();
    jwt.verify.mockReturnValue({
      sub: 'u-2',
      email: 'b@x.com',
      isSuperuser: true,
      mustResetPassword: false,
    } as any);
    const guard = new WsAuthGuard(jwt, makeConfig());
    const client = makeClient({ authHeader: 'Bearer tok-bearer' });

    const result = guard.canActivate(makeContext(client));

    expect(result).toBe(true);
    expect(jwt.verify).toHaveBeenCalledWith('tok-bearer', expect.anything());
    expect((client.data as any).user.id).toBe('u-2');
    expect((client.data as any).user.isSuperuser).toBe(true);
  });

  it('handshake.auth.token tem precedência sobre header Authorization', () => {
    const jwt = makeJwt();
    jwt.verify.mockReturnValue({
      sub: 'u',
      email: 'e',
      isSuperuser: false,
      mustResetPassword: false,
    } as any);
    const guard = new WsAuthGuard(jwt, makeConfig());
    const client = makeClient({ authToken: 'auth-token', authHeader: 'Bearer header-token' });

    guard.canActivate(makeContext(client));

    expect(jwt.verify).toHaveBeenCalledWith('auth-token', expect.anything());
  });

  it('quando token está ausente, desconecta o cliente e retorna false', () => {
    const jwt = makeJwt();
    const guard = new WsAuthGuard(jwt, makeConfig());
    const client = makeClient();

    const result = guard.canActivate(makeContext(client));

    expect(result).toBe(false);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(jwt.verify).not.toHaveBeenCalled();
  });

  it('quando jwt.verify lança, desconecta e retorna false', () => {
    const jwt = makeJwt();
    jwt.verify.mockImplementation(() => {
      throw new Error('jwt expired');
    });
    const guard = new WsAuthGuard(jwt, makeConfig());
    const client = makeClient({ authToken: 'invalid' });

    const result = guard.canActivate(makeContext(client));

    expect(result).toBe(false);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect((client.data as any).user).toBeUndefined();
  });
});
