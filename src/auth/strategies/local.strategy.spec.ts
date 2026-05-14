import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth.service';
import { LocalStrategy } from './local.strategy';

function makeAuthService(validateUser: jest.Mock): AuthService {
  return { validateUser } as unknown as AuthService;
}

describe('LocalStrategy.validate', () => {
  it('retorna user quando authService.validateUser retorna user', async () => {
    const user = { id: 'u-1', email: 'a@x.com' };
    const validate = jest.fn().mockResolvedValue(user);
    const strategy = new LocalStrategy(makeAuthService(validate));

    const result = await strategy.validate('a@x.com', 'senha123');

    expect(validate).toHaveBeenCalledWith('a@x.com', 'senha123');
    expect(result).toBe(user);
  });

  it('lança UnauthorizedException quando authService retorna null', async () => {
    const validate = jest.fn().mockResolvedValue(null);
    const strategy = new LocalStrategy(makeAuthService(validate));
    await expect(strategy.validate('a@x.com', 'errada')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('propaga exceção lançada pelo authService', async () => {
    const validate = jest.fn().mockRejectedValue(new Error('db down'));
    const strategy = new LocalStrategy(makeAuthService(validate));
    await expect(strategy.validate('a@x.com', 'x')).rejects.toThrow('db down');
  });
});
