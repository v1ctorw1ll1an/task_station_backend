import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_RETENTION_DAYS = 365;

/**
 * Apaga fisicamente registros soft-deleted há mais de `SOFT_DELETE_RETENTION_DAYS` dias.
 * TaskAttachment é tratado pelo `AttachmentJanitorService` (precisa também limpar arquivos
 * de disco).
 */
@Injectable()
export class SoftDeletePurgeService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(SoftDeletePurgeService.name)
    private readonly logger: PinoLogger,
  ) {}

  private get cutoff(): Date {
    const days = parseInt(
      process.env.SOFT_DELETE_RETENTION_DAYS ?? String(DEFAULT_RETENTION_DAYS),
      10,
    );
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  @Cron(CronExpression.EVERY_WEEK)
  async runWeekly(): Promise<void> {
    await this.run();
  }

  async run(): Promise<Record<string, number>> {
    const cutoff = this.cutoff;
    const where = { deletedAt: { not: null, lt: cutoff } };
    const result: Record<string, number> = {};

    // Ordem: filhos antes de pais para respeitar FKs (mesmo com cascade,
    // explicitar reduz volume de cascade dentro de uma única transação).
    const steps: Array<[string, () => Promise<{ count: number }>]> = [
      ['taskChecklist', () => this.prisma.taskChecklist.deleteMany({ where })],
      ['taskComment', () => this.prisma.taskComment.deleteMany({ where })],
      ['taskGuest', () => this.prisma.taskGuest.deleteMany({ where })],
      ['task', () => this.prisma.task.deleteMany({ where })],
      ['label', () => this.prisma.label.deleteMany({ where })],
      ['column', () => this.prisma.column.deleteMany({ where })],
      ['project', () => this.prisma.project.deleteMany({ where })],
      ['calendarEvent', () => this.prisma.calendarEvent.deleteMany({ where })],
      ['stickyNote', () => this.prisma.stickyNote.deleteMany({ where })],
      ['notification', () => this.prisma.notification.deleteMany({ where })],
      ['membership', () => this.prisma.membership.deleteMany({ where })],
      ['workspace', () => this.prisma.workspace.deleteMany({ where })],
      ['company', () => this.prisma.company.deleteMany({ where })],
      ['user', () => this.prisma.user.deleteMany({ where })],
    ];

    for (const [name, fn] of steps) {
      try {
        const r = await fn();
        result[name] = r.count;
      } catch (err) {
        result[name] = -1;
        this.logger.error(
          { model: name, err: (err as Error).message },
          'Falha ao expurgar soft-deletes do modelo',
        );
      }
    }

    this.logger.info({ cutoff: cutoff.toISOString(), ...result }, 'Soft-delete purge completed');
    return result;
  }
}
