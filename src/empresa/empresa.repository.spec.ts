import { MembershipRole, ResourceType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmpresaRepository } from './empresa.repository';

/**
 * `createWorkspaceWithMembers` decide, dentro de uma transação, quem entra no workspace
 * e com que papel. Nenhum teste de service enxerga isso — eles param na chamada ao
 * repositório — e o erro que interessa aqui (criador de fora do que criou, ou membership
 * duplicada) só aparece na tela do usuário. Daí o spec no nível do repositório.
 */
function makeTx() {
  return {
    workspace: {
      create: jest.fn().mockResolvedValue({ id: 'ws-1', name: 'Marketing' }),
    },
    membership: {
      create: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function makePrisma(tx: ReturnType<typeof makeTx>) {
  const prisma = {
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  };
  return prisma as unknown as jest.Mocked<PrismaService> & typeof prisma;
}

describe('EmpresaRepository.createWorkspaceWithMembers', () => {
  let tx: ReturnType<typeof makeTx>;
  let repo: EmpresaRepository;

  const params = {
    workspaceName: 'Marketing',
    companyId: 'company-1',
    createdById: 'creator-1',
    memberIds: [] as string[],
  };

  beforeEach(() => {
    tx = makeTx();
    repo = new EmpresaRepository(makePrisma(tx));
  });

  it('põe o criador como workspace_admin do que acabou de criar', async () => {
    await repo.createWorkspaceWithMembers(params);

    expect(tx.membership.create).toHaveBeenCalledWith({
      data: {
        userId: 'creator-1',
        resourceType: ResourceType.workspace,
        resourceId: 'ws-1',
        role: MembershipRole.workspace_admin,
      },
    });
  });

  it('não duplica quando o criador também está na lista de membros', async () => {
    await repo.createWorkspaceWithMembers({
      ...params,
      memberIds: ['creator-1', 'user-2'],
    });

    // Uma linha só para o criador, e com o papel maior — não rebaixado a member.
    expect(tx.membership.create).toHaveBeenCalledTimes(1);
    expect(tx.membership.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          {
            userId: 'user-2',
            resourceType: ResourceType.workspace,
            resourceId: 'ws-1',
            role: MembershipRole.member,
          },
        ],
      }),
    );
  });

  it('não chama createMany quando só há o criador', async () => {
    await repo.createWorkspaceWithMembers({ ...params, memberIds: ['creator-1'] });

    expect(tx.membership.createMany).not.toHaveBeenCalled();
  });
});
