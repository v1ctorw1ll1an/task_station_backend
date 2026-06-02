/**
 * Cria um usuário regular (não-superuser) + empresa + membership de admin da empresa.
 *
 * Pré-requisito para o seed-agenda.ts, que precisa de um usuário não-superuser
 * que já seja admin de uma empresa.
 *
 * Idempotente: se o usuário/empresa/membership já existirem, reaproveita.
 *
 * Credenciais (env vars, com defaults):
 *   SEED_USER_EMAIL    (default: user@taskdy.com)
 *   SEED_USER_PASSWORD (default: User@123456)
 *   SEED_USER_NAME     (default: Regular User)
 *   SEED_COMPANY_NAME  (default: Acme Ltda)
 *   SEED_COMPANY_TAXID (default: 00.000.000/0001-00)
 */
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';

dotenv.config();

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL as string,
});
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.env.SEED_USER_EMAIL ?? 'user@taskdy.com';
  const password = process.env.SEED_USER_PASSWORD ?? 'User@123456';
  const name = process.env.SEED_USER_NAME ?? 'Regular User';
  const companyName = process.env.SEED_COMPANY_NAME ?? 'Acme Ltda';
  const taxId = process.env.SEED_COMPANY_TAXID ?? '00.000.000/0001-00';

  // 1) Usuário regular (não-superuser)
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const passwordHash = await bcrypt.hash(password, 10);
    user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        isSuperuser: false,
        mustResetPassword: false,
        isActive: true,
      },
    });
    console.log(`✓ Usuário regular criado: ${user.email}`);
  } else {
    console.log(`• Usuário já existe: ${user.email}`);
  }

  // 2) Empresa (taxId é único — reaproveita se já existir)
  let company = await prisma.company.findUnique({ where: { taxId } });
  if (!company) {
    company = await prisma.company.create({
      data: {
        legalName: companyName,
        taxId,
        createdById: user.id,
        isActive: true,
      },
    });
    console.log(`✓ Empresa criada: ${company.legalName} (${company.id})`);
  } else {
    console.log(`• Empresa já existe: ${company.legalName} (${company.id})`);
  }

  // 3) Membership: usuário admin da empresa
  const existingMembership = await prisma.membership.findFirst({
    where: {
      userId: user.id,
      resourceType: 'company',
      resourceId: company.id,
      deletedAt: null,
    },
  });
  if (!existingMembership) {
    await prisma.membership.create({
      data: {
        userId: user.id,
        resourceType: 'company',
        resourceId: company.id,
        role: 'admin',
      },
    });
    console.log(`✓ Membership criada: ${user.email} → admin de ${company.legalName}`);
  } else {
    console.log(`• Membership já existe: ${user.email} → ${company.legalName}`);
  }

  console.log('');
  console.log('Credenciais do usuário regular:');
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
