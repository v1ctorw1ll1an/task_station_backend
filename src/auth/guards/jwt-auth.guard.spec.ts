import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeReflector(getAllAndOverride: jest.Mock = jest.fn()): Reflector {
  return { getAllAndOverride } as unknown as Reflector;
}

function makeContext(): ExecutionContext {
  return {
    getHandler: jest.fn().mockReturnValue('handler'),
    getClass: jest.fn().mockReturnValue('class'),
  } as unknown as ExecutionContext;
}

// ── canActivate ────────────────────────────────────────────────────────────────

describe('JwtAuthGuard.canActivate', () => {
  it('retorna true quando @Public() está aplicado, sem delegar ao Passport', () => {
    const reflector = makeReflector(jest.fn().mockReturnValue(true));
    const guard = new JwtAuthGuard(reflector);
    const superSpy = jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(false);

    const result = guard.canActivate(makeContext());

    expect(result).toBe(true);
    expect(superSpy).not.toHaveBeenCalled();
    superSpy.mockRestore();
  });

  it('delega ao Passport (super.canActivate) quando rota não é pública', () => {
    const reflector = makeReflector(jest.fn().mockReturnValue(false));
    const guard = new JwtAuthGuard(reflector);
    const superSpy = jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true);

    const result = guard.canActivate(makeContext());

    expect(superSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
    superSpy.mockRestore();
  });

  it('quando reflector retorna undefined (sem decorator), delega ao Passport', () => {
    const reflector = makeReflector(jest.fn().mockReturnValue(undefined));
    const guard = new JwtAuthGuard(reflector);
    const superSpy = jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true);

    guard.canActivate(makeContext());
    expect(superSpy).toHaveBeenCalled();
    superSpy.mockRestore();
  });

  it('consulta o reflector com IS_PUBLIC_KEY em handler e classe', () => {
    const getAllAndOverride = jest.fn().mockReturnValue(false);
    const guard = new JwtAuthGuard(makeReflector(getAllAndOverride));
    const superSpy = jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true);

    guard.canActivate(makeContext());

    expect(getAllAndOverride).toHaveBeenCalledWith('isPublic', ['handler', 'class']);
    superSpy.mockRestore();
  });
});
