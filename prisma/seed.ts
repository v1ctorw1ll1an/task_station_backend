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
  const email = process.env.SEED_SUPERUSER_EMAIL ?? 'admin@taskstation.com';
  const password = process.env.SEED_SUPERUSER_PASSWORD ?? 'Admin@123456';

  const existing = await prisma.user.findFirst({
    where: { isSuperuser: true, deletedAt: null },
  });

  if (existing) {
    console.log(`Superusuário já existe: ${existing.email}`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: 'Super Admin',
      isSuperuser: true,
      mustResetPassword: false,
    },
  });

  console.log(`Superusuário criado: ${user.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
