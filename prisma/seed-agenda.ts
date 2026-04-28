/**
 * Popula o banco com workspaces, projetos e tarefas para testar a Agenda.
 *
 * Modos:
 *   pnpm tsx prisma/seed-agenda.ts             # cria 6 workspaces, 24 projetos, 360 tasks
 *   pnpm tsx prisma/seed-agenda.ts --refresh   # NÃO cria nada; só redistribui dueDate das tasks
 *                                              # já criadas pelo seed em torno de HOJE
 *
 * Lê o usuário pelo env var SEED_AGENDA_EMAIL (default: primeiro não-superuser).
 * Usa a empresa em que o usuário já é admin (a primeira encontrada).
 *
 * Identificação dos dados de seed: workspace.description termina com "(seed)".
 */
import { PrismaClient, TaskPriority } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';

dotenv.config();

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL as string });
const prisma = new PrismaClient({ adapter });

const WORKSPACES = [
  { name: 'Engenharia', icon: 'Code2', color: '#3b82f6' },
  { name: 'Design', icon: 'Palette', color: '#a855f7' },
  { name: 'Marketing', icon: 'Megaphone', color: '#f59e0b' },
  { name: 'Operações', icon: 'Workflow', color: '#10b981' },
  { name: 'Produto', icon: 'Rocket', color: '#ef4444' },
  { name: 'Suporte', icon: 'Headphones', color: '#06b6d4' },
];

const PROJECT_TEMPLATES = [
  { name: 'Plataforma Web', icon: 'Globe', color: '#3b82f6' },
  { name: 'App Mobile', icon: 'Smartphone', color: '#10b981' },
  { name: 'API Pública', icon: 'Server', color: '#f59e0b' },
  { name: 'Onboarding', icon: 'Sparkles', color: '#a855f7' },
  { name: 'Performance', icon: 'Gauge', color: '#ef4444' },
  { name: 'Faturamento', icon: 'CreditCard', color: '#8b5cf6' },
  { name: 'Integrações', icon: 'GitBranch', color: '#06b6d4' },
  { name: 'Dashboard', icon: 'LayoutDashboard', color: '#ec4899' },
  { name: 'Auth e Permissões', icon: 'Shield', color: '#64748b' },
  { name: 'Notificações', icon: 'Bell', color: '#facc15' },
];

const TASK_VERBS = [
  'Revisar', 'Implementar', 'Corrigir', 'Atualizar', 'Refatorar',
  'Documentar', 'Otimizar', 'Validar', 'Testar', 'Investigar',
  'Migrar', 'Configurar', 'Desenvolver', 'Ajustar', 'Remover',
];

const TASK_OBJECTS = [
  'fluxo de login', 'tela de relatórios', 'integração com Stripe', 'cache de sessão',
  'webhook de pagamento', 'paginação da listagem', 'componente de filtros',
  'queries N+1', 'envio de e-mail', 'upload de avatar', 'permissões de admin',
  'modal de confirmação', 'cálculo de saldo', 'export de CSV', 'campanha de push',
  'rota /api/v1/tasks', 'tabela de membros', 'tema escuro', 'sidebar mobile',
  'tela de onboarding', 'feature flag de pricing', 'deploy do staging',
  'pipeline de CI', 'migração para Prisma 7', 'política de retenção',
];

const PRIORITIES: TaskPriority[] = ['urgent', 'high', 'medium', 'low'];

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickPriority(): TaskPriority {
  // Distribuição: 15% urgent, 25% high, 40% medium, 20% low
  const r = Math.random();
  if (r < 0.15) return 'urgent';
  if (r < 0.4) return 'high';
  if (r < 0.8) return 'medium';
  return 'low';
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return startOfDay(x);
}

/**
 * Distribui as datas para deixar a Agenda densa em hoje/semana e ainda popular mês/ano.
 * Retorna 15 datas por projeto.
 */
function makeDueDateDistribution(today: Date): Date[] {
  const dates: Date[] = [];
  // 2 hoje
  dates.push(today, today);
  // 2 amanhã
  dates.push(addDays(today, 1), addDays(today, 1));
  // 3 nos próximos 7 dias
  for (let i = 0; i < 3; i++) dates.push(addDays(today, 2 + Math.floor(Math.random() * 6)));
  // 3 dentro do mês
  for (let i = 0; i < 3; i++) dates.push(addDays(today, 8 + Math.floor(Math.random() * 22)));
  // 3 nos próximos 6 meses
  for (let i = 0; i < 3; i++) dates.push(addDays(today, 31 + Math.floor(Math.random() * 150)));
  // 2 atrasadas
  for (let i = 0; i < 2; i++) dates.push(addDays(today, -1 - Math.floor(Math.random() * 7)));
  return dates;
}

async function refresh(userId: string, companyId: string, today: Date) {
  // Pega todas as tasks que pertencem a workspaces de seed (description "(seed)")
  // e estão atribuídas ao usuário-alvo. Atualiza só o dueDate.
  const tasks = await prisma.task.findMany({
    where: {
      deletedAt: null,
      taskAssignees: { some: { userId } },
      project: {
        deletedAt: null,
        workspace: {
          companyId,
          deletedAt: null,
          description: { endsWith: '(seed)' },
        },
      },
    },
    select: { id: true, projectId: true },
    orderBy: [{ projectId: 'asc' }, { createdAt: 'asc' }],
  });

  if (tasks.length === 0) {
    console.log('Nenhuma task de seed encontrada. Rode sem --refresh para criar dados primeiro.');
    return;
  }

  // Agrupa por projeto e gera distribuição de datas por projeto
  const byProject = new Map<string, string[]>();
  for (const t of tasks) {
    if (!byProject.has(t.projectId)) byProject.set(t.projectId, []);
    byProject.get(t.projectId)!.push(t.id);
  }

  let updated = 0;
  for (const [, taskIds] of byProject) {
    const dates = makeDueDateDistribution(today);
    // Garante que temos datas suficientes (caso o projeto tenha mais que 15)
    while (dates.length < taskIds.length) dates.push(...makeDueDateDistribution(today));
    // Embaralha pra não ficar determinístico
    dates.sort(() => Math.random() - 0.5);

    for (let i = 0; i < taskIds.length; i++) {
      await prisma.task.update({
        where: { id: taskIds[i] },
        data: { dueDate: dates[i] },
      });
      updated += 1;
    }
  }

  console.log(`✓ ${updated} tasks tiveram dueDate redistribuído em torno de ${today.toISOString().slice(0, 10)}.`);
}

async function main() {
  const isRefresh = process.argv.includes('--refresh');

  const targetEmail = process.env.SEED_AGENDA_EMAIL;
  const user = targetEmail
    ? await prisma.user.findUnique({ where: { email: targetEmail } })
    : await prisma.user.findFirst({
        where: { isSuperuser: false, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });

  if (!user) {
    console.error('Nenhum usuário encontrado. Defina SEED_AGENDA_EMAIL ou crie um usuário primeiro.');
    process.exit(1);
  }

  const companyMembership = await prisma.membership.findFirst({
    where: { userId: user.id, resourceType: 'company', deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });

  if (!companyMembership) {
    console.error(`Usuário ${user.email} não pertence a nenhuma empresa.`);
    process.exit(1);
  }

  const companyId = companyMembership.resourceId;
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  console.log(`→ Usuário: ${user.email}`);
  console.log(`→ Empresa: ${company?.legalName} (${companyId})`);
  console.log(`→ Modo: ${isRefresh ? 'refresh (atualiza dueDates)' : 'create (cria workspaces/projetos/tasks)'}`);
  console.log('');

  const today = startOfDay(new Date());

  if (isRefresh) {
    await refresh(user.id, companyId, today);
    return;
  }

  let totalTasks = 0;

  for (const wsTemplate of WORKSPACES) {
    const ws = await prisma.workspace.create({
      data: {
        companyId,
        name: wsTemplate.name,
        description: `Workspace ${wsTemplate.name} (seed)`,
        createdById: user.id,
      },
    });

    // Adiciona o usuário como workspace_admin
    await prisma.membership.create({
      data: {
        userId: user.id,
        resourceType: 'workspace',
        resourceId: ws.id,
        role: 'workspace_admin',
      },
    });

    console.log(`  📁 Workspace: ${ws.name}`);

    // 4 projetos por workspace
    const projTemplates = [...PROJECT_TEMPLATES].sort(() => Math.random() - 0.5).slice(0, 4);

    for (const projTpl of projTemplates) {
      const project = await prisma.project.create({
        data: {
          workspaceId: ws.id,
          name: projTpl.name,
          description: `${projTpl.name} (seed)`,
          icon: projTpl.icon,
          iconColor: projTpl.color,
          createdById: user.id,
        },
      });

      // 3 colunas: A Fazer, Em Andamento, Concluído
      const colTodo = await prisma.column.create({
        data: { projectId: project.id, name: 'A Fazer', order: 1000, color: '#64748b', isDone: false },
      });
      const colDoing = await prisma.column.create({
        data: { projectId: project.id, name: 'Em Andamento', order: 2000, color: '#f59e0b', isDone: false },
      });
      const colDone = await prisma.column.create({
        data: { projectId: project.id, name: 'Concluído', order: 3000, color: '#10b981', isDone: true },
      });

      // 15 tasks com datas distribuídas
      const dueDates = makeDueDateDistribution(today);
      let taskNumber = 0;
      let orderTodo = 1000;
      let orderDoing = 1000;
      let orderDone = 1000;

      for (let i = 0; i < dueDates.length; i++) {
        // 60% A Fazer, 30% Em Andamento, 10% Concluído (mas Concluído tem isDone=true e não aparece na agenda)
        const r = Math.random();
        let column = colTodo;
        let order = orderTodo;
        if (r < 0.6) {
          column = colTodo;
          order = orderTodo;
          orderTodo += 1000;
        } else if (r < 0.9) {
          column = colDoing;
          order = orderDoing;
          orderDoing += 1000;
        } else {
          column = colDone;
          order = orderDone;
          orderDone += 1000;
        }

        taskNumber += 1;
        const title = `${rand(TASK_VERBS)} ${rand(TASK_OBJECTS)}`;

        const task = await prisma.task.create({
          data: {
            projectId: project.id,
            columnId: column.id,
            taskNumber,
            title,
            priority: pickPriority(),
            order,
            reporterId: user.id,
            createdById: user.id,
            dueDate: dueDates[i],
          },
        });

        // Atribui o usuário à task — necessário para aparecer em /me/tasks
        await prisma.taskAssignee.create({
          data: { taskId: task.id, userId: user.id },
        });

        totalTasks += 1;
      }

      // Atualiza contador do projeto
      await prisma.project.update({
        where: { id: project.id },
        data: { taskCounter: taskNumber },
      });

      console.log(`    └─ ${project.name}: ${dueDates.length} tasks`);
    }
  }

  console.log('');
  console.log(`✓ Criados ${WORKSPACES.length} workspaces, ${WORKSPACES.length * 4} projetos, ${totalTasks} tasks.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
