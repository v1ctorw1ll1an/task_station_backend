import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { FREE } from '../common/limits';
import { checkDateRange } from '../common/date-range';
import { markdownToWhatsapp, balanceWhatsappEmphasis } from '../common/markdown-to-whatsapp';
import { Prisma } from '../generated/prisma/client';
import { ProjetoRepository } from '../projeto/projeto.repository';
import { KanbanGateway } from '../projeto/kanban.gateway';
import { CreateChecklistDto } from '../projeto/dto/create-checklist.dto';
import { UpdateChecklistDto } from '../projeto/dto/update-checklist.dto';
import { ReorderChecklistDto } from '../projeto/dto/reorder-checklist.dto';
import { CreateCommentDto } from '../projeto/dto/create-comment.dto';
import { UpdateCommentDto } from '../projeto/dto/update-comment.dto';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateTaskPublicDto } from './dto/update-task-public.dto';
import { TaskGuestRepository } from './task-guest.repository';

type GuestCtx = { guestId: string; taskId: string; projectId: string };

export interface CreateGuestResult {
  guest: {
    id: string;
    name: string;
    phoneE164: string;
    email: string | null;
    invitedAt: Date;
    expiresAt: Date | null;
  };
  publicUrl: string;
  whatsappUrl: string;
}

const E164_REGEX = /^\+[1-9]\d{7,14}$/;
const WA_MESSAGE_MAX = 1800;
const DEFAULT_GUEST_TTL_DAYS = 30;
const GUEST_MESSAGE_FOOTER =
  `\n\n_Quer experimentar o TaskDY na sua empresa?_\n` + `https://taskstation.manyflux.com.br`;

@Injectable()
export class TaskGuestService {
  constructor(
    private readonly repo: TaskGuestRepository,
    private readonly projetoRepo: ProjetoRepository,
    private readonly kanbanGateway: KanbanGateway,
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

    // Cap de guests/task — anti-abuso de enumeração de telefones e
    // spam por WhatsApp via wa.me links.
    const existingGuests = await this.repo.countActiveGuestsByTask(taskId);
    if (existingGuests >= FREE.guestsPerTask) {
      throw new BadRequestException(
        `Limite de ${FREE.guestsPerTask} convidados por task atingido.`,
      );
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    // Link público sem vencimento: o acesso é controlado manualmente pelo
    // owner/admin via toggle habilitar/desabilitar (linkEnabled).
    const expiresAt = null;

    const guest = await this.repo.createGuest({
      taskId,
      name: dto.name,
      phoneE164,
      email: dto.email ?? null,
      tokenHash,
      rawToken,
      invitedById,
      expiresAt,
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
        expiresAt: guest.expiresAt,
      },
      publicUrl,
      whatsappUrl,
    };
  }

  async extendGuest(guestId: string, days = DEFAULT_GUEST_TTL_DAYS) {
    const guest = await this.repo.findActiveGuestById(guestId);
    if (!guest) {
      throw new NotFoundException('Convidado não encontrado');
    }
    const expiresAt = days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
    return this.repo.extendGuestExpiration(guestId, expiresAt);
  }

  async searchGuests(projectId: string, q: string) {
    const project = await this.repo.findProjectWorkspaceId(projectId);
    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }
    return this.repo.searchDistinctGuestsInWorkspace(project.workspaceId, q.trim());
  }

  async listGuests(taskId: string, userId: string, isAdmin: boolean) {
    const [guests, task] = await Promise.all([
      this.repo.listActiveGuestsByTask(taskId),
      this.repo.findTaskReporter(taskId),
    ]);
    const canManage = isAdmin || task?.reporterId === userId;
    return guests.map((g) => ({
      id: g.id,
      name: g.name,
      phoneE164: g.phoneE164,
      email: g.email,
      invitedAt: g.invitedAt,
      lastAccessedAt: g.lastAccessedAt,
      linkEnabled: g.linkEnabled,
      canManage,
      // URL só é exposta a quem pode gerenciar (owner/admin) e quando há token.
      publicUrl: canManage && g.rawToken ? this.buildPublicUrl(g.rawToken) : null,
    }));
  }

  async setGuestLinkEnabled(
    taskId: string,
    guestId: string,
    enabled: boolean,
    userId: string,
    isAdmin: boolean,
  ) {
    const guest = await this.repo.findActiveGuestById(guestId);
    if (!guest || guest.taskId !== taskId) {
      throw new NotFoundException('Convidado não encontrado');
    }
    const task = await this.repo.findTaskReporter(taskId);
    if (!isAdmin && task?.reporterId !== userId) {
      throw new ForbiddenException('Apenas o owner da task ou um admin pode gerenciar o link');
    }
    await this.repo.setLinkEnabled(guestId, enabled);
    this.logger.info({ guestId, taskId, enabled, userId }, 'Link público do convidado atualizado');
    return { id: guestId, linkEnabled: enabled };
  }

  async getPublicTask(ctx: { guestId: string; taskId: string }) {
    const task = await this.repo.findPublicTaskById(ctx.taskId);
    if (!task) {
      throw new NotFoundException('Task não encontrada');
    }

    // Convidado não vê funcionários internos: assignees são omitidos do payload.
    return {
      id: task.id,
      taskNumber: task.taskNumber,
      title: task.title,
      description: task.description,
      priority: task.priority,
      startDate: task.startDate,
      dueDate: task.dueDate,
      allDay: task.allDay,
      timezone: task.timezone,
      order: task.order,
      column: task.column,
      labels: task.taskLabels.map((l) => ({
        id: l.label.id,
        name: l.label.name,
        color: l.label.color,
      })),
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

  getPublicColumns(ctx: GuestCtx) {
    return this.repo.findProjectColumns(ctx.projectId);
  }

  getPublicLabels(ctx: GuestCtx) {
    return this.repo.findProjectLabels(ctx.projectId);
  }

  async updatePublicTask(
    ctx: { guestId: string; taskId: string; projectId: string },
    dto: UpdateTaskPublicDto,
  ) {
    const current = await this.repo.findPublicTaskById(ctx.taskId);
    if (!current) {
      throw new NotFoundException('Task não encontrada');
    }

    // Mesma regra do evento (término ≥ início), validando o par resultante.
    const effectiveStart = dto.startDate !== undefined ? dto.startDate : current.startDate;
    const effectiveDue = dto.dueDate !== undefined ? dto.dueDate : current.dueDate;
    if (effectiveStart && effectiveDue) {
      const { invalid, outOfOrder } = checkDateRange(effectiveStart, effectiveDue);
      if (invalid) {
        throw new BadRequestException('Datas inválidas');
      }
      if (outOfOrder) {
        throw new BadRequestException('O término deve ser maior ou igual ao início');
      }
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

    if (dto.allDay !== undefined && dto.allDay !== current.allDay) {
      data.allDay = dto.allDay;
    }

    if (dto.timezone !== undefined && dto.timezone !== current.timezone) {
      data.timezone = dto.timezone;
    }

    if (dto.columnId !== undefined && dto.columnId !== current.column.id) {
      const column = await this.repo.findColumnByIdInProject(dto.columnId, ctx.projectId);
      if (!column) {
        throw new BadRequestException('Coluna inválida para este projeto');
      }
      data.column = { connect: { id: dto.columnId } };
      history.push({ field: 'columnId', oldValue: current.column.id, newValue: dto.columnId });
    }

    let labelChanges: { add: string[]; remove: string[] } | undefined;
    if (dto.labelIds !== undefined) {
      const desired = [...new Set(dto.labelIds)];
      const validIds = await this.repo.findLabelIdsInProject(desired, ctx.projectId);
      if (validIds.length !== desired.length) {
        throw new BadRequestException('Label inválida para este projeto');
      }
      const currentIds = current.taskLabels.map((l) => l.label.id);
      const desiredSet = new Set(desired);
      const currentSet = new Set(currentIds);
      const add = desired.filter((id) => !currentSet.has(id));
      const remove = currentIds.filter((id) => !desiredSet.has(id));
      if (add.length > 0 || remove.length > 0) {
        labelChanges = { add, remove };
        const projectLabels = await this.repo.findProjectLabels(ctx.projectId);
        const nameById = new Map(projectLabels.map((l) => [l.id, l.name]));
        const oldNames =
          current.taskLabels
            .map((l) => l.label.name)
            .sort()
            .join(', ') || null;
        const newNames =
          desired
            .map((id) => nameById.get(id) ?? '')
            .filter(Boolean)
            .sort()
            .join(', ') || null;
        history.push({ field: 'labels', oldValue: oldNames, newValue: newNames });
      }
    }

    if (history.length === 0) {
      return this.getPublicTask(ctx);
    }

    await this.repo.applyPublicTaskUpdate(ctx.taskId, ctx.guestId, data, history, labelChanges);

    this.logger.info(
      { guestId: ctx.guestId, taskId: ctx.taskId, fields: history.map((h) => h.field) },
      'Task atualizada por convidado',
    );

    await this.emitTaskUpdated(ctx);
    return this.getPublicTask(ctx);
  }

  // ── Realtime helpers ──────────────────────────────────────────────────────────

  private async emitTaskUpdated(ctx: GuestCtx) {
    const task = await this.projetoRepo.findTaskById(ctx.taskId, ctx.projectId);
    if (task) {
      this.kanbanGateway.emitToProject(ctx.projectId, 'task:updated', {
        task,
        actorId: `guest:${ctx.guestId}`,
      });
    }
    this.kanbanGateway.emitToTask(ctx.taskId, 'task:changed', { taskId: ctx.taskId });
  }

  private emitDetailChanged(ctx: GuestCtx) {
    this.kanbanGateway.emitToProject(ctx.projectId, 'task:detailChanged', { taskId: ctx.taskId });
    this.kanbanGateway.emitToTask(ctx.taskId, 'task:changed', { taskId: ctx.taskId });
  }

  // ── Checklist (convidado) ───────────────────────────────────────────────────────

  listPublicChecklists(ctx: GuestCtx) {
    return this.projetoRepo.findChecklistsByTask(ctx.taskId);
  }

  async createPublicChecklist(ctx: GuestCtx, dto: CreateChecklistDto) {
    const count = await this.projetoRepo.countChecklistsByTask(ctx.taskId);
    const item = await this.repo.createGuestChecklist(ctx.taskId, dto.title, count + 1);
    await this.repo.createGuestHistories(ctx.taskId, ctx.guestId, [
      { field: 'checklist.created', oldValue: null, newValue: item.title },
    ]);
    this.emitDetailChanged(ctx);
    return item;
  }

  async updatePublicChecklist(ctx: GuestCtx, checklistId: string, dto: UpdateChecklistDto) {
    const item = await this.projetoRepo.findChecklistById(checklistId, ctx.taskId);
    if (!item) throw new NotFoundException('Item não encontrado');

    const updated = await this.projetoRepo.updateChecklist(checklistId, dto);
    const entries: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
    if (dto.title !== undefined && dto.title !== item.title) {
      entries.push({ field: 'checklist.renamed', oldValue: item.title, newValue: updated.title });
    }
    if (dto.completed !== undefined && dto.completed !== item.completed) {
      entries.push({
        field: dto.completed ? 'checklist.completed' : 'checklist.uncompleted',
        oldValue: null,
        newValue: updated.title,
      });
    }
    await this.repo.createGuestHistories(ctx.taskId, ctx.guestId, entries);
    this.emitDetailChanged(ctx);
    return updated;
  }

  async deletePublicChecklist(ctx: GuestCtx, checklistId: string) {
    const item = await this.projetoRepo.findChecklistById(checklistId, ctx.taskId);
    if (!item) throw new NotFoundException('Item não encontrado');
    await this.projetoRepo.softDeleteChecklist(checklistId);
    await this.repo.createGuestHistories(ctx.taskId, ctx.guestId, [
      { field: 'checklist.deleted', oldValue: item.title, newValue: null },
    ]);
    this.emitDetailChanged(ctx);
  }

  async reorderPublicChecklists(ctx: GuestCtx, dto: ReorderChecklistDto) {
    await this.projetoRepo.reorderChecklists(dto.items);
    this.emitDetailChanged(ctx);
  }

  // ── Comentários (convidado) ──────────────────────────────────────────────────────

  async listPublicComments(ctx: GuestCtx) {
    const comments = await this.projetoRepo.findCommentsByTask(ctx.taskId);
    return comments.map((c) => this.mapPublicComment(c, ctx.guestId));
  }

  async createPublicComment(ctx: GuestCtx, dto: CreateCommentDto) {
    const comment = await this.repo.createGuestComment(ctx.taskId, ctx.guestId, dto.content);
    this.emitDetailChanged(ctx);
    return this.mapPublicComment(comment, ctx.guestId);
  }

  async updateOwnPublicComment(ctx: GuestCtx, commentId: string, dto: UpdateCommentDto) {
    const comment = await this.projetoRepo.findCommentById(commentId, ctx.taskId);
    if (!comment) throw new NotFoundException('Comentário não encontrado');
    if (comment.guestId !== ctx.guestId) {
      throw new ForbiddenException('Você só pode editar seus próprios comentários');
    }
    const updated = await this.projetoRepo.updateComment(commentId, dto.content);
    this.emitDetailChanged(ctx);
    return this.mapPublicComment(updated, ctx.guestId);
  }

  async deleteOwnPublicComment(ctx: GuestCtx, commentId: string) {
    const comment = await this.projetoRepo.findCommentById(commentId, ctx.taskId);
    if (!comment) throw new NotFoundException('Comentário não encontrado');
    if (comment.guestId !== ctx.guestId) {
      throw new ForbiddenException('Você só pode excluir seus próprios comentários');
    }
    await this.projetoRepo.softDeleteComment(commentId);
    this.emitDetailChanged(ctx);
  }

  // Autores internos viram "Equipe"; convidados mantêm o nome e ganham flag isYou.
  private mapPublicComment(
    c: {
      id: string;
      content: string;
      createdAt: Date;
      updatedAt: Date;
      userId: string | null;
      guestId: string | null;
      guest: { id: string; name: string } | null;
    },
    myGuestId: string,
  ) {
    return {
      id: c.id,
      content: c.content,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      author: c.guestId ? (c.guest?.name ?? 'Convidado') : 'Equipe',
      isGuest: !!c.guestId,
      isYou: c.guestId === myGuestId,
    };
  }

  // ── Histórico (convidado) ────────────────────────────────────────────────────────

  async listPublicHistory(ctx: GuestCtx, page: number, limit: number) {
    const { items, total } = await this.projetoRepo.getTaskHistoryPaginated(
      ctx.taskId,
      page,
      limit,
    );
    return {
      data: items.map((h) => ({
        id: h.id,
        field: h.field,
        oldValue: h.oldValue,
        newValue: h.newValue,
        changedAt: h.changedAt,
        author: h.guest ? h.guest.name : 'Equipe',
        isYou: h.guest?.id === ctx.guestId,
      })),
      total,
      page,
      limit,
    };
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

  // Resolve as entradas de histórico solicitadas e traduz columnId→nome.
  private async resolveHistoryEntries(taskId: string, historyEntryIds: string[]) {
    const rawEntries = await this.repo.findHistoryEntriesForTask(taskId, historyEntryIds);
    if (rawEntries.length === 0) {
      throw new BadRequestException('Nenhuma alteração válida para enviar');
    }
    const columnIds = new Set<string>();
    for (const entry of rawEntries) {
      if (entry.field === 'columnId') {
        if (entry.oldValue) columnIds.add(entry.oldValue);
        if (entry.newValue) columnIds.add(entry.newValue);
      }
    }
    const columnNames =
      columnIds.size > 0 ? await this.repo.findColumnNamesByIds([...columnIds]) : {};
    return rawEntries.map((entry) => {
      if (entry.field !== 'columnId') return entry;
      return {
        ...entry,
        oldValue: entry.oldValue ? (columnNames[entry.oldValue] ?? '(coluna removida)') : null,
        newValue: entry.newValue ? (columnNames[entry.newValue] ?? '(coluna removida)') : null,
      };
    });
  }

  // Retorna apenas o resumo das mudanças (texto editável compartilhado, sem
  // saudação/link/rodapé — adicionados por convidado no envio).
  async previewGuestNotify(
    taskId: string,
    historyEntryIds: string[],
  ): Promise<{ message: string }> {
    const entries = await this.resolveHistoryEntries(taskId, historyEntryIds);
    return { message: this.buildChangesSummary(entries) };
  }

  async buildGuestNotifyUrl(
    taskId: string,
    guestId: string,
    historyEntryIds: string[],
    customMessage?: string,
  ): Promise<{ whatsappUrl: string; publicUrl: string; fields: string[] }> {
    const guest = await this.repo.findGuestWithTask(guestId);
    if (!guest || guest.taskId !== taskId) {
      throw new NotFoundException('Convidado não encontrado');
    }

    const entries = await this.resolveHistoryEntries(taskId, historyEntryIds);

    // Link estável: reusa o token já existente (o mesmo que o owner copia/liga).
    // Só gera+salva um token quando o convidado ainda não tiver um.
    let rawToken = guest.rawToken;
    if (!rawToken) {
      rawToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      await this.repo.rotateGuestToken(guestId, tokenHash, rawToken);
    }
    const publicUrl = this.buildPublicUrl(rawToken);

    const body = customMessage?.trim() ? customMessage : this.buildChangesSummary(entries);
    const reportText = this.composeReportMessage(guest.name, body, publicUrl);
    const digits = guest.phoneE164.replace(/\D+/g, '');
    const whatsappUrl = `https://wa.me/${digits}?text=${encodeURIComponent(reportText)}`;

    this.logger.info(
      { guestId, taskId, count: entries.length, custom: !!customMessage },
      'Relatório de mudanças construído para convidado (link estável)',
    );

    return {
      whatsappUrl,
      publicUrl,
      fields: entries.map((e) => e.field),
    };
  }

  // Lista de mudanças (corpo editável). Formatação segura para WhatsApp:
  // só *negrito* em rótulos, valores em aspas, sem tachado (~) nem wrapping por linha.
  private buildChangesSummary(
    entries: Array<{ field: string; oldValue: string | null; newValue: string | null }>,
  ): string {
    return entries.map((e) => this.renderHistoryLine(e)).join('\n');
  }

  // Monta a mensagem final por convidado: saudação + corpo + link + rodapé.
  private composeReportMessage(guestName: string, body: string, publicUrl: string): string {
    const message =
      `Olá *${guestName}*,\n\n` +
      `${body}\n\n` +
      `*Acesse a task:*\n${publicUrl}` +
      `${GUEST_MESSAGE_FOOTER}`;
    return this.truncateForWhatsapp(message);
  }

  private renderHistoryLine(entry: {
    field: string;
    oldValue: string | null;
    newValue: string | null;
  }): string {
    if (entry.field.startsWith('checklist.')) {
      return this.renderChecklistLine(entry);
    }

    const label = this.fieldLabel(entry.field);

    if (entry.field === 'description') {
      const novo = this.describeValue(entry.newValue);
      return `• *${label}* atualizada:\n  "${novo}"`;
    }

    const oldVal = this.formatFieldValue(entry.field, entry.oldValue);
    const newVal = this.formatFieldValue(entry.field, entry.newValue);
    return `• *${label}*: "${oldVal}" → "${newVal}"`;
  }

  private renderChecklistLine(entry: {
    field: string;
    oldValue: string | null;
    newValue: string | null;
  }): string {
    switch (entry.field) {
      case 'checklist.created':
        return `• *Checklist* (novo item): "${entry.newValue ?? ''}"`;
      case 'checklist.completed':
        return `• *Checklist* (concluído): "${entry.newValue ?? ''}"`;
      case 'checklist.uncompleted':
        return `• *Checklist* (reaberto): "${entry.newValue ?? ''}"`;
      case 'checklist.renamed':
        return `• *Checklist* (renomeado): "${entry.oldValue ?? ''}" → "${entry.newValue ?? ''}"`;
      case 'checklist.deleted':
        return `• *Checklist* (removido): "${entry.oldValue ?? ''}"`;
      default:
        return `• *Checklist*: "${entry.oldValue ?? ''}" → "${entry.newValue ?? ''}"`;
    }
  }

  private formatFieldValue(field: string, value: string | null): string {
    if (value === null || value === '') return 'vazio';
    if (field === 'priority') return this.priorityLabel(value);
    return value.length > 60 ? `${value.slice(0, 57)}...` : value;
  }

  private describeValue(value: string | null): string {
    if (value === null || value === '') return 'vazio';
    // A descrição é Markdown — converte para a sintaxe do WhatsApp antes de
    // embutir no preview, senão `**`, `##`, `[](...)` apareceriam crus.
    const wa = markdownToWhatsapp(value);
    const oneLine = wa.replace(/\s*\n\s*/g, ' ').trim();
    if (oneLine === '') return 'vazio';
    const truncated = oneLine.length > 180 ? `${oneLine.slice(0, 177)}...` : oneLine;
    // O corte pode separar um par de ênfase — remove marcador órfão.
    return balanceWhatsappEmphasis(truncated);
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
      `• Acompanhar o andamento da task\n` +
      `• Editar título, descrição, prioridade e datas\n` +
      `• Mover entre colunas (status)\n` +
      `• Marcar itens do checklist\n` +
      `• Receber atualizações sempre que houver mudanças\n\n` +
      `_O objetivo é que você colabore com a equipe na evolução desta task, sem precisar de cadastro._\n\n` +
      `*Acesse a task:*\n${publicUrl}` +
      `${GUEST_MESSAGE_FOOTER}`;
    return `https://wa.me/${digits}?text=${encodeURIComponent(this.truncateForWhatsapp(message))}`;
  }

  private truncateForWhatsapp(message: string): string {
    if (message.length <= WA_MESSAGE_MAX) return message;
    return `${message.slice(0, WA_MESSAGE_MAX - 30)}... ver detalhes no link.`;
  }
}
