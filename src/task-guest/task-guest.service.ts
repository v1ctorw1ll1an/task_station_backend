import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Prisma } from '../generated/prisma/client';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateTaskPublicDto } from './dto/update-task-public.dto';
import { TaskGuestRepository } from './task-guest.repository';

export interface CreateGuestResult {
  guest: {
    id: string;
    name: string;
    phoneE164: string;
    email: string | null;
    invitedAt: Date;
  };
  publicUrl: string;
  whatsappUrl: string;
}

const E164_REGEX = /^\+[1-9]\d{7,14}$/;
const WA_MESSAGE_MAX = 1800;

@Injectable()
export class TaskGuestService {
  constructor(
    private readonly repo: TaskGuestRepository,
    private readonly configService: ConfigService,
    @InjectPinoLogger(TaskGuestService.name)
    private readonly logger: PinoLogger,
  ) {}

  async createGuest(
    taskId: string,
    invitedById: string,
    dto: CreateGuestDto,
  ): Promise<CreateGuestResult> {
    const phoneE164 = this.normalizePhone(dto.phone);

    const task = await this.repo.findActiveTaskById(taskId);
    if (!task) {
      throw new NotFoundException('Task não encontrada');
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const guest = await this.repo.createGuest({
      taskId,
      name: dto.name,
      phoneE164,
      email: dto.email ?? null,
      tokenHash,
      invitedById,
    });

    const publicUrl = this.buildPublicUrl(rawToken);
    const whatsappUrl = this.buildWelcomeWhatsappUrl(phoneE164, dto.name, task.title, publicUrl);

    this.logger.info(
      {
        guestId: guest.id,
        taskId,
        invitedById,
        tokenHashPrefix: tokenHash.slice(0, 8),
      },
      'Convidado criado para task',
    );

    return {
      guest: {
        id: guest.id,
        name: dto.name,
        phoneE164,
        email: dto.email ?? null,
        invitedAt: guest.invitedAt,
      },
      publicUrl,
      whatsappUrl,
    };
  }

  async searchGuests(projectId: string, q: string) {
    const project = await this.repo.findProjectWorkspaceId(projectId);
    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }
    return this.repo.searchDistinctGuestsInWorkspace(project.workspaceId, q.trim());
  }

  listGuests(taskId: string) {
    return this.repo.listActiveGuestsByTask(taskId);
  }

  async getPublicTask(ctx: { guestId: string; taskId: string }) {
    const task = await this.repo.findPublicTaskById(ctx.taskId);
    if (!task) {
      throw new NotFoundException('Task não encontrada');
    }

    return {
      id: task.id,
      taskNumber: task.taskNumber,
      title: task.title,
      description: task.description,
      priority: task.priority,
      startDate: task.startDate,
      dueDate: task.dueDate,
      order: task.order,
      column: task.column,
      assignees: task.taskAssignees.map((a) => ({
        name: a.user.name,
        photoUrl: a.user.photoUrl,
      })),
      labels: task.taskLabels.map((l) => ({ name: l.label.name, color: l.label.color })),
      checklists: task.taskChecklists.map((c) => ({
        id: c.id,
        title: c.title,
        completed: c.completed,
        order: c.order,
      })),
      guests: task.taskGuests.map((g) => ({
        id: g.id,
        name: g.name,
        isYou: g.id === ctx.guestId,
      })),
      permissions: { canEdit: true },
    };
  }

  async updatePublicTask(
    ctx: { guestId: string; taskId: string; projectId: string },
    dto: UpdateTaskPublicDto,
  ) {
    const current = await this.repo.findPublicTaskById(ctx.taskId);
    if (!current) {
      throw new NotFoundException('Task não encontrada');
    }

    const data: Prisma.TaskUpdateInput = {};
    const history: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];

    if (dto.title !== undefined && dto.title !== current.title) {
      data.title = dto.title;
      history.push({ field: 'title', oldValue: current.title, newValue: dto.title });
    }

    if (dto.description !== undefined && dto.description !== current.description) {
      data.description = dto.description;
      history.push({
        field: 'description',
        oldValue: current.description ?? null,
        newValue: dto.description ?? null,
      });
    }

    if (dto.priority !== undefined && dto.priority !== current.priority) {
      data.priority = dto.priority;
      history.push({ field: 'priority', oldValue: current.priority, newValue: dto.priority });
    }

    const startDateChanged = this.diffDate(current.startDate, dto.startDate);
    if (startDateChanged.changed) {
      data.startDate = startDateChanged.newValue;
      history.push({
        field: 'startDate',
        oldValue: startDateChanged.oldIso,
        newValue: startDateChanged.newIso,
      });
    }

    const dueDateChanged = this.diffDate(current.dueDate, dto.dueDate);
    if (dueDateChanged.changed) {
      data.dueDate = dueDateChanged.newValue;
      history.push({
        field: 'dueDate',
        oldValue: dueDateChanged.oldIso,
        newValue: dueDateChanged.newIso,
      });
    }

    if (dto.columnId !== undefined && dto.columnId !== current.column.id) {
      const column = await this.repo.findColumnByIdInProject(dto.columnId, ctx.projectId);
      if (!column) {
        throw new BadRequestException('Coluna inválida para este projeto');
      }
      data.column = { connect: { id: dto.columnId } };
      history.push({ field: 'columnId', oldValue: current.column.id, newValue: dto.columnId });
    }

    if (history.length === 0) {
      return this.getPublicTask(ctx);
    }

    await this.repo.applyPublicTaskUpdate(ctx.taskId, ctx.guestId, data, history);

    this.logger.info(
      { guestId: ctx.guestId, taskId: ctx.taskId, fields: history.map((h) => h.field) },
      'Task atualizada por convidado',
    );

    return this.getPublicTask(ctx);
  }

  private diffDate(
    current: Date | null,
    incoming: string | null | undefined,
  ): { changed: boolean; newValue: Date | null; oldIso: string | null; newIso: string | null } {
    if (incoming === undefined) {
      return { changed: false, newValue: null, oldIso: null, newIso: null };
    }
    const newValue = incoming === null ? null : new Date(incoming);
    const oldIso = current ? current.toISOString() : null;
    const newIso = newValue ? newValue.toISOString() : null;
    return { changed: oldIso !== newIso, newValue, oldIso, newIso };
  }

  async revokeGuest(taskId: string, guestId: string): Promise<void> {
    const guest = await this.repo.findActiveGuestById(guestId);
    if (!guest || guest.taskId !== taskId) {
      throw new NotFoundException('Convidado não encontrado');
    }
    await this.repo.softDeleteGuest(guestId);
    this.logger.info({ guestId, taskId }, 'Convidado revogado');
  }

  private normalizePhone(input: string): string {
    const digits = input.replace(/\D+/g, '');
    const candidate = `+${digits}`;
    if (!E164_REGEX.test(candidate)) {
      throw new BadRequestException('Telefone inválido. Use o formato internacional (E.164).');
    }
    return candidate;
  }

  private buildPublicUrl(rawToken: string): string {
    const frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
    return `${frontendUrl.replace(/\/$/, '')}/public/task/${rawToken}`;
  }

  async buildGuestNotifyUrl(
    taskId: string,
    guestId: string,
    historyEntryIds: string[],
  ): Promise<{ whatsappUrl: string; publicUrl: string; fields: string[] }> {
    const guest = await this.repo.findGuestWithTask(guestId);
    if (!guest || guest.taskId !== taskId) {
      throw new NotFoundException('Convidado não encontrado');
    }

    const rawEntries = await this.repo.findHistoryEntriesForTask(taskId, historyEntryIds);
    if (rawEntries.length === 0) {
      throw new BadRequestException('Nenhuma alteração válida para enviar');
    }

    // Traduz IDs de coluna para nomes (caso o histórico tenha mudança de status)
    const columnIds = new Set<string>();
    for (const entry of rawEntries) {
      if (entry.field === 'columnId') {
        if (entry.oldValue) columnIds.add(entry.oldValue);
        if (entry.newValue) columnIds.add(entry.newValue);
      }
    }
    const columnNames =
      columnIds.size > 0 ? await this.repo.findColumnNamesByIds([...columnIds]) : {};
    const entries = rawEntries.map((entry) => {
      if (entry.field !== 'columnId') return entry;
      return {
        ...entry,
        oldValue: entry.oldValue ? (columnNames[entry.oldValue] ?? '(coluna removida)') : null,
        newValue: entry.newValue ? (columnNames[entry.newValue] ?? '(coluna removida)') : null,
      };
    });

    // Re-emite o token público: salvamos apenas o hash, então a única forma de
    // expor um link clicável na mensagem é gerar um novo token. O link anterior
    // é invalidado (substituído por este). O convidado sempre usa o link mais recente.
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await this.repo.rotateGuestToken(guestId, tokenHash);
    const publicUrl = this.buildPublicUrl(rawToken);

    const reportText = this.buildReportMessage(guest.name, guest.task.title, entries, publicUrl);
    const digits = guest.phoneE164.replace(/\D+/g, '');
    const whatsappUrl = `https://wa.me/${digits}?text=${encodeURIComponent(reportText)}`;

    this.logger.info(
      {
        guestId,
        taskId,
        count: entries.length,
        tokenHashPrefix: tokenHash.slice(0, 8),
      },
      'Relatório de mudanças construído para convidado (token rotacionado)',
    );

    return {
      whatsappUrl,
      publicUrl,
      fields: entries.map((e) => e.field),
    };
  }

  private buildReportMessage(
    guestName: string,
    taskTitle: string,
    entries: Array<{ field: string; oldValue: string | null; newValue: string | null }>,
    publicUrl: string,
  ): string {
    const header = `Olá *${guestName}*,\n\nA task *${taskTitle}* foi atualizada:`;
    const lines = entries.map((e) => this.renderHistoryLine(e)).join('\n\n');
    const linkSection = `\n\n*Acesse a task:*\n${publicUrl}`;
    const footer =
      `\n\n--------------------------------\n` +
      `_Quer experimentar o TaskDY na sua empresa?_\n` +
      `https://taskstation.manyflux.com.br`;

    return this.truncateForWhatsapp(`${header}\n\n${lines}${linkSection}${footer}`);
  }

  private renderHistoryLine(entry: {
    field: string;
    oldValue: string | null;
    newValue: string | null;
  }): string {
    const label = this.fieldLabel(entry.field);
    const oldValRaw = this.formatFieldValue(entry.field, entry.oldValue);
    const newValRaw = this.formatFieldValue(entry.field, entry.newValue);

    if (entry.field === 'description') {
      const oldBlock = this.formatDescriptionBlock(entry.oldValue, 'old');
      const newBlock = this.formatDescriptionBlock(entry.newValue, 'new');
      return `*${label}:*\n${oldBlock}\n   ->\n${newBlock}`;
    }

    if (entry.field.startsWith('checklist.')) {
      return this.renderChecklistLine(entry);
    }

    return `- *${label}:* ~"${oldValRaw}"~ -> *"${newValRaw}"*`;
  }

  private renderChecklistLine(entry: {
    field: string;
    oldValue: string | null;
    newValue: string | null;
  }): string {
    switch (entry.field) {
      case 'checklist.created':
        return `- *Checklist* — novo item: *"${entry.newValue ?? ''}"*`;
      case 'checklist.completed':
        return `- *Checklist* — concluído: [X] *"${entry.newValue ?? ''}"*`;
      case 'checklist.uncompleted':
        return `- *Checklist* — reaberto: [ ] *"${entry.newValue ?? ''}"*`;
      case 'checklist.renamed':
        return `- *Checklist* — renomeado: ~"${entry.oldValue ?? ''}"~ -> *"${entry.newValue ?? ''}"*`;
      case 'checklist.deleted':
        return `- *Checklist* — removido: ~"${entry.oldValue ?? ''}"~`;
      default:
        return `- *Checklist*: ${entry.oldValue ?? ''} -> ${entry.newValue ?? ''}`;
    }
  }

  private formatFieldValue(field: string, value: string | null): string {
    if (value === null || value === '') return 'vazio';
    if (field === 'priority') return this.priorityLabel(value);
    return value.length > 60 ? `${value.slice(0, 57)}...` : value;
  }

  private formatDescriptionBlock(value: string | null, variant: 'old' | 'new'): string {
    const wrap = (line: string) => (variant === 'old' ? `~${line}~` : `*${line}*`);
    if (value === null || value === '') return `   ${wrap('_(vazio)_')}`;
    const truncated = value.length > 180 ? `${value.slice(0, 177)}...` : value;
    return truncated
      .split('\n')
      .map((l) => `   ${wrap(l)}`)
      .join('\n');
  }

  private priorityLabel(value: string): string {
    const map: Record<string, string> = {
      low: 'Baixa',
      medium: 'Média',
      high: 'Alta',
      urgent: 'Urgente',
    };
    return map[value] ?? value;
  }

  private fieldLabel(field: string): string {
    const map: Record<string, string> = {
      title: 'Título',
      description: 'Descrição',
      priority: 'Prioridade',
      startDate: 'Início',
      dueDate: 'Vencimento',
      columnId: 'Status',
      assignees: 'Responsáveis',
      labels: 'Labels',
    };
    return map[field] ?? field;
  }

  private buildWelcomeWhatsappUrl(
    phoneE164: string,
    guestName: string,
    taskTitle: string,
    publicUrl: string,
  ): string {
    const digits = phoneE164.replace(/\D+/g, '');
    const message =
      `Olá *${guestName}*!\n\n` +
      `Você foi adicionado como *convidado* na task *${taskTitle}* no TaskDY.\n\n` +
      `*O que você pode fazer:*\n` +
      `- Acompanhar o andamento da task\n` +
      `- Editar título, descrição, prioridade e datas\n` +
      `- Mover entre colunas (status)\n` +
      `- Marcar itens do checklist\n` +
      `- Receber atualizações sempre que houver mudanças\n\n` +
      `_O objetivo é que você colabore com a equipe na evolução desta task — sem precisar de cadastro._\n\n` +
      `*Acesse a task:*\n${publicUrl}\n\n` +
      `--------------------------------\n` +
      `_Quer experimentar o TaskDY na sua empresa?_\n` +
      `https://taskstation.manyflux.com.br`;
    return `https://wa.me/${digits}?text=${encodeURIComponent(this.truncateForWhatsapp(message))}`;
  }

  private truncateForWhatsapp(message: string): string {
    if (message.length <= WA_MESSAGE_MAX) return message;
    return `${message.slice(0, WA_MESSAGE_MAX - 30)}... ver detalhes no link.`;
  }
}
