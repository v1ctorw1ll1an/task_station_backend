import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { SuperuserGuard } from './superuser.guard';

function makeContext(user: Record<string, unknown> | null): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('SuperuserGuard.canActivate', () => {
  it('retorna true quando user.isSuperuser=true', () => {
    const guard = new SuperuserGuard();
    expect(guard.canActivate(makeContext({ id: 'u-1', isSuperuser: true }))).toBe(true);
  });

  it('lança ForbiddenException quando user.isSuperuser=false', () => {
    const guard = new SuperuserGuard();
    expect(() => guard.canActivate(makeContext({ id: 'u-1', isSuperuser: false }))).toThrow(
      ForbiddenException,
    );
  });

  it('lança ForbiddenException quando user é null/undefined', () => {
    const guard = new SuperuserGuard();
    expect(() => guard.canActivate(makeContext(null))).toThrow(ForbiddenException);
  });
});
