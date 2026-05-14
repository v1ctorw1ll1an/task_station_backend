import { ConfigService } from '@nestjs/config';
import { JwtStrategy, JwtPayload } from './jwt.strategy';

function makeConfig(secret = 'test-secret'): ConfigService {
  return {
    getOrThrow: jest.fn().mockReturnValue(secret),
  } as unknown as ConfigService;
}

describe('JwtStrategy', () => {
  it('constructor lê JWT_SECRET via ConfigService.getOrThrow', () => {
    const config = makeConfig('seg-1');
    new JwtStrategy(config);
    expect(config.getOrThrow).toHaveBeenCalledWith('JWT_SECRET');
  });

  it('constructor lança quando JWT_SECRET ausente', () => {
    const config = {
      getOrThrow: jest.fn().mockImplementation(() => {
        throw new Error('Missing JWT_SECRET');
      }),
    } as unknown as ConfigService;
    expect(() => new JwtStrategy(config)).toThrow('Missing JWT_SECRET');
  });

  it('validate mapeia payload (sub→id) e copia demais campos', () => {
    const strategy = new JwtStrategy(makeConfig());
    const payload: JwtPayload = {
      sub: 'u-1',
      email: 'a@x.com',
      isSuperuser: true,
      mustResetPassword: false,
    };
    expect(strategy.validate(payload)).toEqual({
      id: 'u-1',
      email: 'a@x.com',
      isSuperuser: true,
      mustResetPassword: false,
    });
  });

  it('validate preserva mustResetPassword=true', () => {
    const strategy = new JwtStrategy(makeConfig());
    const result = strategy.validate({
      sub: 'u-2',
      email: 'b@x.com',
      isSuperuser: false,
      mustResetPassword: true,
    });
    expect(result.mustResetPassword).toBe(true);
  });
});
