import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const p = new PrismaClient({ adapter });

(async () => {
  const company = await p.company.findFirst({
    where: { deletedAt: null },
    select: {
      id: true, legalName: true,
      workspaces: {
        where: { deletedAt: null }, take: 1,
        select: {
          id: true, name: true,
          projects: {
            where: { deletedAt: null }, take: 1,
            select: {
              id: true, name: true,
              columns: {
                where: { deletedAt: null }, take: 1,
                select: {
                  id: true, name: true,
                  tasks: { where: { deletedAt: null }, take: 1, select: { id: true, title: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  console.log(JSON.stringify(company, null, 2));
  await p.$disconnect();
})();
