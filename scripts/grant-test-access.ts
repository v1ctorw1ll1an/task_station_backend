import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const USER_EMAIL = process.env.USER_EMAIL ?? 'admin@taskdy.com';
const COMPANY_ID = process.env.COMPANY_ID!;
const WORKSPACE_ID = process.env.WORKSPACE_ID!;
const PROJECT_ID = process.env.PROJECT_ID!;

const p = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

(async () => {
  const user = await p.user.findFirst({ where: { email: USER_EMAIL } });
  if (!user) throw new Error(`Usuário ${USER_EMAIL} não existe`);

  const rows = [
    { resourceType: 'company' as const, resourceId: COMPANY_ID, role: 'admin' as const },
    { resourceType: 'workspace' as const, resourceId: WORKSPACE_ID, role: 'workspace_admin' as const },
    { resourceType: 'project' as const, resourceId: PROJECT_ID, role: 'member' as const },
  ];

  for (const row of rows) {
    const existing = await p.membership.findFirst({
      where: { userId: user.id, resourceType: row.resourceType, resourceId: row.resourceId },
    });
    if (existing) {
      await p.membership.update({
        where: { id: existing.id },
        data: { role: row.role, deletedAt: null },
      });
    } else {
      await p.membership.create({
        data: { userId: user.id, ...row },
      });
    }
    console.log(`✓ ${row.resourceType} ${row.resourceId} → ${row.role}`);
  }
  await p.$disconnect();
})();
