import { GUARDS_METADATA } from '@nestjs/common/constants';
import { SuperuserGuard } from '../superadmin/guards/superuser.guard';
import { ApiTokenController } from './api-token.controller';

/**
 * A integração com o Claude Code é só de superusuário. Quem decide isso é o
 * `SuperuserGuard` em cada rota de gestão — este teste falha se ele sumir de alguma,
 * ou se for parar em `current`, que é chamada pelo próprio token (sem poder de
 * superusuário, por regra) e por isso derrubaria o MCP.
 */
describe('ApiTokenController — só superusuário', () => {
  const guardsOf = (handler: keyof ApiTokenController): unknown[] =>
    (Reflect.getMetadata(GUARDS_METADATA, ApiTokenController.prototype[handler]) as
      | unknown[]
      | undefined) ?? [];

  it.each(['list', 'listWorkspaces', 'create', 'revoke'] as const)(
    '%s exige superusuário',
    (handler) => {
      expect(guardsOf(handler)).toContain(SuperuserGuard);
    },
  );

  it('current não exige — quem chama é o token, e a trava está no authenticate', () => {
    expect(guardsOf('current')).not.toContain(SuperuserGuard);
  });

  it('o guard não está no controller inteiro (pegaria current junto)', () => {
    const classGuards =
      (Reflect.getMetadata(GUARDS_METADATA, ApiTokenController) as unknown[] | undefined) ?? [];
    expect(classGuards).not.toContain(SuperuserGuard);
  });
});
