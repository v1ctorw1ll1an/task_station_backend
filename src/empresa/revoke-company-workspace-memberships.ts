import type { Prisma } from '../generated/prisma/client';

type Db = Pick<Prisma.TransactionClient, 'membership' | 'workspace'>;

/**
 * A metade de "sair da empresa" que é fácil esquecer: tira as pessoas de **todos** os
 * workspaces da empresa.
 *
 * Só o vínculo de empresa ocupa assento, mas quem dá acesso é o de workspace
 * (`WorkspaceMemberGuard`, `ProjetoMemberGuard`). Apagar só o primeiro libera o assento
 * e deixa a pessoa trabalhando nos workspaces sem pagar — foi o bug da redução de
 * assentos (R19) e da inativação de vínculo pelo superusuário.
 *
 * Inclui os workspaces da lixeira: se um dia existir restaurar workspace, ele não pode
 * devolver o acesso de quem já saiu. Devolve quantos vínculos caíram.
 */
export async function revokeCompanyWorkspaceMemberships(
  db: Db,
  companyId: string,
  userIds: string[],
  now: Date,
): Promise<number> {
  if (userIds.length === 0) return 0;

  const workspaces = await db.workspace.findMany({
    where: { companyId },
    select: { id: true },
  });
  if (workspaces.length === 0) return 0;

  const { count } = await db.membership.updateMany({
    where: {
      userId: { in: userIds },
      resourceType: 'workspace',
      resourceId: { in: workspaces.map((w) => w.id) },
      deletedAt: null,
    },
    data: { deletedAt: now },
  });
  return count;
}
