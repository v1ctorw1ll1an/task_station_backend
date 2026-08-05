import { PrismaClient, ResourceType, SubscriptionStatus } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';

dotenv.config();

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL as string });
const prisma = new PrismaClient({ adapter });

/**
 * Backfill de cobrança para empresas legadas (RF-C7).
 *
 * Toda empresa ativa SEM assinatura recebe uma assinatura `courtesy` (isenta —
 * acesso livre, sem cobrança) para não ser bloqueada quando `BILLING_ENABLED=true`
 * (empresa sem assinatura hoje passa livre, mas isso é um buraco no rollout). Novas
 * empresas já nascem em `trial` pelos fluxos de criação/self-signup.
 *
 * Idempotente: só cria para quem não tem assinatura; seguro rodar mais de uma vez.
 *
 *   pnpm backfill:billing            # aplica
 *   pnpm backfill:billing --dry-run  # só mostra o que faria
 */
async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const companies = await prisma.company.findMany({
    where: { deletedAt: null, subscription: { is: null } },
    select: { id: true, legalName: true },
  });

  if (companies.length === 0) {
    console.log('Nenhuma empresa sem assinatura — nada a fazer.');
    return;
  }

  console.log(`${companies.length} empresa(s) sem assinatura${dryRun ? ' (dry-run)' : ''}:`);

  let created = 0;
  for (const c of companies) {
    // Assentos = memberships ativas de empresa; mínimo 1 (para dados coerentes na UI).
    const occupied = await prisma.membership.count({
      where: { resourceType: ResourceType.company, resourceId: c.id, deletedAt: null },
    });
    const purchasedSeats = Math.max(1, occupied);

    if (dryRun) {
      console.log(`  • ${c.legalName} (${c.id}) → courtesy, ${purchasedSeats} assento(s)`);
      continue;
    }

    try {
      await prisma.subscription.create({
        data: { companyId: c.id, status: SubscriptionStatus.courtesy, purchasedSeats },
      });
      created++;
      console.log(`  ✓ ${c.legalName} (${c.id}) → courtesy, ${purchasedSeats} assento(s)`);
    } catch (err) {
      // Corrida (unique companyId) → já foi criada; idempotente, ignora.
      console.warn(`  ! ${c.id} pulada:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    dryRun ? 'Dry-run concluído.' : `Concluído: ${created} assinatura(s) courtesy criada(s).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
