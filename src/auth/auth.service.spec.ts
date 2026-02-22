import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { TokenType } from '../generated/prisma/client';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'test@example.com',
    passwordHash: '$2b$10$hashedpassword',
    name: 'Test User',
    phone: null,
    photoUrl: null,
    isActive: true,
    isSuperuser: false,
    mustResetPassword: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function makeToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'token-1',
    userId: 'user-1',
    tokenHash: 'hashed-token',
    type: TokenType.password_reset,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    usedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<Record<keyof AuthRepository, jest.Mock>> = {},
): jest.Mocked<AuthRepository> {
  return {
    findActiveUserByEmail: jest.fn(),
    findActiveUserById: jest.fn(),
    updateUser: jest.fn(),
    invalidateTokensByType: jest.fn(),
    createPasswordResetToken: jest.fn(),
    findPasswordResetToken: jest.fn(),
    findPasswordResetTokenWithUser: jest.fn(),
    markTokenUsed: jest.fn(),
    resetPasswordWithToken: jest.fn(),
    consumeFirstAccessToken: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<AuthRepository>;
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeService(
  repo: jest.Mocked<AuthRepository>,
  configOverrides: Record<string, unknown> = {},
) {
  const jwtService = { sign: jest.fn().mockReturnValue('jwt-token') } as unknown as JwtService;
  const configService = {
    get: jest.fn((key: string, fallback?: unknown) => {
      const map: Record<string, unknown> = {
        FRONTEND_URL: 'http://localhost:3000',
        PASSWORD_RESET_EXPIRES_IN: 3600,
        FIRST_ACCESS_EXPIRES_DAYS: 7,
        ...configOverrides,
      };
      return map[key] ?? fallback;
    }),
    getOrThrow: jest.fn((key: string) => {
      const map: Record<string, unknown> = {
        FRONTEND_URL: 'http://localhost:3000',
        ...configOverrides,
      };
      if (!(key in map)) throw new Error(`Config key ${key} not found`);
      return map[key];
    }),
  } as unknown as ConfigService;
  const mailerService = { sendPasswordResetEmail: jest.fn(), sendFirstAccessEmail: jest.fn() };
  const logger = makeLogger();

  return new AuthService(repo, jwtService, configService, mailerService as any, logger as any);
}

// ── validateUser ───────────────────────────────────────────────────────────────

describe('AuthService.validateUser', () => {
  it('retorna null quando email não encontrado', async () => {
    const repo = makeRepo({ findActiveUserByEmail: jest.fn().mockResolvedValue(null) });
    const service = makeService(repo);
    const result = await service.validateUser('noemail@x.com', 'pass');
    expect(result).toBeNull();
  });

  it('lança UnauthorizedException para usuário inativo', async () => {
    const repo = makeRepo({
      findActiveUserByEmail: jest.fn().mockResolvedValue(makeUser({ isActive: false })),
    });
    const service = makeService(repo);
    await expect(service.validateUser('test@example.com', 'pass')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('retorna null quando senha incorreta', async () => {
    const user = makeUser({ passwordHash: await bcrypt.hash('correctpass', 10) });
    const repo = makeRepo({ findActiveUserByEmail: jest.fn().mockResolvedValue(user) });
    const service = makeService(repo);
    const result = await service.validateUser('test@example.com', 'wrongpass');
    expect(result).toBeNull();
  });

  it('retorna usuário sem passwordHash quando credenciais válidas', async () => {
    const plainPassword = 'correctpass';
    const user = makeUser({ passwordHash: await bcrypt.hash(plainPassword, 10) });
    const repo = makeRepo({ findActiveUserByEmail: jest.fn().mockResolvedValue(user) });
    const service = makeService(repo);
    const result = await service.validateUser('test@example.com', plainPassword);
    expect(result).not.toBeNull();
    expect((result as any).passwordHash).toBeUndefined();
    expect(result!.id).toBe('user-1');
  });
});

// ── login ──────────────────────────────────────────────────────────────────────

describe('AuthService.login', () => {
  it('retorna access_token e dados do usuário', () => {
    const repo = makeRepo();
    const service = makeService(repo);
    const result = service.login({
      id: 'user-1',
      email: 'test@example.com',
      isSuperuser: false,
      mustResetPassword: false,
    });
    expect(result.access_token).toBe('jwt-token');
    expect(result.user.id).toBe('user-1');
    expect(result.user.email).toBe('test@example.com');
  });
});

// ── resetPassword ──────────────────────────────────────────────────────────────

describe('AuthService.resetPassword', () => {
  it('lança BadRequestException quando senhas não coincidem', async () => {
    const repo = makeRepo();
    const service = makeService(repo);
    await expect(
      service.resetPassword('user-1', {
        newPassword: 'pass1',
        confirmPassword: 'pass2',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('chama updateUser com hash e mustResetPassword=false', async () => {
    const repo = makeRepo({ updateUser: jest.fn().mockResolvedValue({}) });
    const service = makeService(repo);
    await service.resetPassword('user-1', {
      newPassword: 'SamePass1!',
      confirmPassword: 'SamePass1!',
    });
    expect(repo.updateUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ mustResetPassword: false }),
    );
    const callData = (repo.updateUser.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(callData.passwordHash).toBeDefined();
    expect(typeof callData.passwordHash).toBe('string');
  });

  it('inclui name no updateData quando name fornecido', async () => {
    const repo = makeRepo({ updateUser: jest.fn().mockResolvedValue({}) });
    const service = makeService(repo);
    await service.resetPassword('user-1', {
      newPassword: 'SamePass1!',
      confirmPassword: 'SamePass1!',
      name: '  João  ',
    });
    const callData = (repo.updateUser.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(callData.name).toBe('João');
  });

  it('não inclui name quando name vazio', async () => {
    const repo = makeRepo({ updateUser: jest.fn().mockResolvedValue({}) });
    const service = makeService(repo);
    await service.resetPassword('user-1', {
      newPassword: 'SamePass1!',
      confirmPassword: 'SamePass1!',
      name: '   ',
    });
    const callData = (repo.updateUser.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(callData.name).toBeUndefined();
  });
});

// ── forgotPassword ─────────────────────────────────────────────────────────────

describe('AuthService.forgotPassword', () => {
  it('não faz nada quando usuário não encontrado (sem revelar existência)', async () => {
    const repo = makeRepo({ findActiveUserByEmail: jest.fn().mockResolvedValue(null) });
    const service = makeService(repo);
    await expect(service.forgotPassword('noemail@x.com')).resolves.toBeUndefined();
    expect(repo.createPasswordResetToken).not.toHaveBeenCalled();
  });

  it('não faz nada quando usuário inativo', async () => {
    const repo = makeRepo({
      findActiveUserByEmail: jest.fn().mockResolvedValue(makeUser({ isActive: false })),
    });
    const service = makeService(repo);
    await service.forgotPassword('test@example.com');
    expect(repo.createPasswordResetToken).not.toHaveBeenCalled();
  });

  it('invalida tokens anteriores e cria novo token', async () => {
    const user = makeUser();
    const repo = makeRepo({
      findActiveUserByEmail: jest.fn().mockResolvedValue(user),
      invalidateTokensByType: jest.fn().mockResolvedValue({ count: 1 }),
      createPasswordResetToken: jest.fn().mockResolvedValue({}),
    });
    const mailerService = { sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined) };
    const service = makeService(repo);
    // injetar mailer manualmente
    (service as any).mailerService = mailerService;

    await service.forgotPassword('test@example.com');

    expect(repo.invalidateTokensByType).toHaveBeenCalledWith('user-1', TokenType.password_reset);
    expect(repo.createPasswordResetToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        type: TokenType.password_reset,
        tokenHash: expect.any(String),
        expiresAt: expect.any(Date),
      }),
    );
    expect(mailerService.sendPasswordResetEmail).toHaveBeenCalledWith(
      'test@example.com',
      expect.stringContaining('/reset-password?token='),
    );
  });
});

// ── confirmResetPassword ───────────────────────────────────────────────────────

describe('AuthService.confirmResetPassword', () => {
  it('lança BadRequestException quando senhas não coincidem', async () => {
    const repo = makeRepo();
    const service = makeService(repo);
    await expect(
      service.confirmResetPassword('rawtoken', { newPassword: 'a', confirmPassword: 'b' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('lança BadRequestException quando token não encontrado', async () => {
    const repo = makeRepo({ findPasswordResetToken: jest.fn().mockResolvedValue(null) });
    const service = makeService(repo);
    await expect(
      service.confirmResetPassword('rawtoken', {
        newPassword: 'SamePass1!',
        confirmPassword: 'SamePass1!',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('lança BadRequestException quando token já usado', async () => {
    const repo = makeRepo({
      findPasswordResetToken: jest.fn().mockResolvedValue(makeToken({ usedAt: new Date() })),
    });
    const service = makeService(repo);
    await expect(
      service.confirmResetPassword('rawtoken', {
        newPassword: 'SamePass1!',
        confirmPassword: 'SamePass1!',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('lança BadRequestException quando token expirado', async () => {
    const repo = makeRepo({
      findPasswordResetToken: jest
        .fn()
        .mockResolvedValue(makeToken({ expiresAt: new Date(Date.now() - 1000) })),
    });
    const service = makeService(repo);
    await expect(
      service.confirmResetPassword('rawtoken', {
        newPassword: 'SamePass1!',
        confirmPassword: 'SamePass1!',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('chama resetPasswordWithToken com hash correto', async () => {
    const token = makeToken();
    const repo = makeRepo({
      findPasswordResetToken: jest.fn().mockResolvedValue(token),
      resetPasswordWithToken: jest.fn().mockResolvedValue([{}, {}]),
    });
    const service = makeService(repo);
    await service.confirmResetPassword('rawtoken', {
      newPassword: 'SamePass1!',
      confirmPassword: 'SamePass1!',
    });
    expect(repo.resetPasswordWithToken).toHaveBeenCalledWith(
      token.userId,
      token.id,
      expect.any(String),
    );
  });
});

// ── validateFirstAccessToken ───────────────────────────────────────────────────

describe('AuthService.validateFirstAccessToken', () => {
  it('lança BadRequestException quando token não encontrado', async () => {
    const repo = makeRepo({ findPasswordResetTokenWithUser: jest.fn().mockResolvedValue(null) });
    const service = makeService(repo);
    await expect(service.validateFirstAccessToken('rawtoken')).rejects.toThrow(BadRequestException);
  });

  it('lança BadRequestException quando tipo errado', async () => {
    const token = { ...makeToken({ type: TokenType.password_reset }), user: { email: 'x@x.com' } };
    const repo = makeRepo({ findPasswordResetTokenWithUser: jest.fn().mockResolvedValue(token) });
    const service = makeService(repo);
    await expect(service.validateFirstAccessToken('rawtoken')).rejects.toThrow(BadRequestException);
  });

  it('lança BadRequestException quando token expirado', async () => {
    const token = {
      ...makeToken({ type: TokenType.first_access, expiresAt: new Date(Date.now() - 1) }),
      user: { email: 'x@x.com' },
    };
    const repo = makeRepo({ findPasswordResetTokenWithUser: jest.fn().mockResolvedValue(token) });
    const service = makeService(repo);
    await expect(service.validateFirstAccessToken('rawtoken')).rejects.toThrow(BadRequestException);
  });

  it('retorna email quando token válido', async () => {
    const token = {
      ...makeToken({ type: TokenType.first_access }),
      user: { email: 'test@example.com' },
    };
    const repo = makeRepo({ findPasswordResetTokenWithUser: jest.fn().mockResolvedValue(token) });
    const service = makeService(repo);
    const result = await service.validateFirstAccessToken('rawtoken');
    expect(result).toEqual({ email: 'test@example.com' });
  });
});

// ── generateFirstAccessToken ───────────────────────────────────────────────────

describe('AuthService.generateFirstAccessToken', () => {
  it('invalida tokens anteriores e cria novo token first_access', async () => {
    const repo = makeRepo({
      invalidateTokensByType: jest.fn().mockResolvedValue({ count: 0 }),
      createPasswordResetToken: jest.fn().mockResolvedValue({}),
    });
    const service = makeService(repo);
    const rawToken = await service.generateFirstAccessToken('user-1');

    expect(typeof rawToken).toBe('string');
    expect(rawToken.length).toBeGreaterThan(10);
    expect(repo.invalidateTokensByType).toHaveBeenCalledWith('user-1', TokenType.first_access);
    expect(repo.createPasswordResetToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        type: TokenType.first_access,
        tokenHash: expect.any(String),
        expiresAt: expect.any(Date),
      }),
    );
  });

  it('token criado expira em ~7 dias por padrão', async () => {
    const repo = makeRepo({
      invalidateTokensByType: jest.fn().mockResolvedValue({ count: 0 }),
      createPasswordResetToken: jest.fn().mockResolvedValue({}),
    });
    const service = makeService(repo);
    const before = Date.now();
    await service.generateFirstAccessToken('user-1');
    const call = repo.createPasswordResetToken.mock.calls[0][0] as { expiresAt: Date };
    const diffDays = (call.expiresAt.getTime() - before) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(6.9);
    expect(diffDays).toBeLessThanOrEqual(7.1);
  });
});

// ── getOrRegenerateFirstAccessToken ───────────────────────────────────────────

describe('AuthService.getOrRegenerateFirstAccessToken', () => {
  it('lança NotFoundException quando usuário não encontrado', async () => {
    const repo = makeRepo({ findActiveUserById: jest.fn().mockResolvedValue(null) });
    const service = makeService(repo);
    await expect(service.getOrRegenerateFirstAccessToken('user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('retorna null quando mustResetPassword=false', async () => {
    const repo = makeRepo({
      findActiveUserById: jest.fn().mockResolvedValue(makeUser({ mustResetPassword: false })),
    });
    const service = makeService(repo);
    const result = await service.getOrRegenerateFirstAccessToken('user-1');
    expect(result).toBeNull();
  });

  it('gera e retorna token quando mustResetPassword=true', async () => {
    const repo = makeRepo({
      findActiveUserById: jest.fn().mockResolvedValue(makeUser({ mustResetPassword: true })),
      invalidateTokensByType: jest.fn().mockResolvedValue({ count: 0 }),
      createPasswordResetToken: jest.fn().mockResolvedValue({}),
    });
    const service = makeService(repo);
    const rawToken = await service.getOrRegenerateFirstAccessToken('user-1');
    expect(typeof rawToken).toBe('string');
    expect(rawToken!.length).toBeGreaterThan(10);
  });
});

// ── invalidateUserCredentials ──────────────────────────────────────────────────

describe('AuthService.invalidateUserCredentials', () => {
  it('lança NotFoundException quando usuário não encontrado', async () => {
    const repo = makeRepo({ findActiveUserById: jest.fn().mockResolvedValue(null) });
    const service = makeService(repo);
    await expect(service.invalidateUserCredentials('user-1', 'admin-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('seta mustResetPassword=true e gera token', async () => {
    const repo = makeRepo({
      findActiveUserById: jest.fn().mockResolvedValue(makeUser()),
      updateUser: jest.fn().mockResolvedValue({}),
      invalidateTokensByType: jest.fn().mockResolvedValue({ count: 0 }),
      createPasswordResetToken: jest.fn().mockResolvedValue({}),
    });
    const service = makeService(repo);
    const rawToken = await service.invalidateUserCredentials('user-1', 'admin-1');
    expect(repo.updateUser).toHaveBeenCalledWith('user-1', { mustResetPassword: true });
    expect(typeof rawToken).toBe('string');
    expect(rawToken.length).toBeGreaterThan(10);
  });
});

// ── consumeFirstAccessToken ────────────────────────────────────────────────────

describe('AuthService.consumeFirstAccessToken', () => {
  it('lança BadRequestException quando senhas não coincidem', async () => {
    const repo = makeRepo();
    const service = makeService(repo);
    await expect(
      service.consumeFirstAccessToken('rawtoken', {
        name: 'João',
        newPassword: 'a',
        confirmPassword: 'b',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('lança BadRequestException quando token inválido ou expirado', async () => {
    const repo = makeRepo({ findPasswordResetToken: jest.fn().mockResolvedValue(null) });
    const service = makeService(repo);
    await expect(
      service.consumeFirstAccessToken('rawtoken', {
        name: 'João',
        newPassword: 'SamePass1!',
        confirmPassword: 'SamePass1!',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('lança BadRequestException quando tipo errado (password_reset)', async () => {
    const token = makeToken({ type: TokenType.password_reset });
    const repo = makeRepo({ findPasswordResetToken: jest.fn().mockResolvedValue(token) });
    const service = makeService(repo);
    await expect(
      service.consumeFirstAccessToken('rawtoken', {
        name: 'João',
        newPassword: 'SamePass1!',
        confirmPassword: 'SamePass1!',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('consome token e retorna JWT quando tudo válido', async () => {
    const token = makeToken({ type: TokenType.first_access });
    const userResult = {
      id: 'user-1',
      email: 'test@example.com',
      isSuperuser: false,
      mustResetPassword: false,
    };
    const repo = makeRepo({
      findPasswordResetToken: jest.fn().mockResolvedValue(token),
      consumeFirstAccessToken: jest.fn().mockResolvedValue(userResult),
    });
    const service = makeService(repo);
    const result = await service.consumeFirstAccessToken('rawtoken', {
      name: '  João  ',
      newPassword: 'SamePass1!',
      confirmPassword: 'SamePass1!',
    });

    expect(repo.consumeFirstAccessToken).toHaveBeenCalledWith(
      token.userId,
      token.id,
      expect.any(String), // bcrypt hash
      'João', // trimmed name
    );
    expect(result.access_token).toBe('jwt-token');
    expect(result.user.id).toBe('user-1');
  });
});
