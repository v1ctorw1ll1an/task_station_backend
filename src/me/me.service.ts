import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as bcrypt from 'bcryptjs';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { MeRepository } from './me.repository';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';
import { ListMyTasksQueryDto, TaskDateFilter } from './dto/list-my-tasks-query.dto';
import { SaveWorkspaceOrderDto } from './dto/save-workspace-order.dto';
import { SaveProjectOrderDto } from './dto/save-project-order.dto';
import { addDays, format, parseISO } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { APP_TIMEZONE, dayRangeInTz } from '../common/date-range';

const AVATARS_ROOT = join(process.cwd(), 'uploads', 'avatars');
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/heic',
  'image/heif',
]);

@Injectable()
export class MeService {
  constructor(
    private readonly repo: MeRepository,
    @InjectPinoLogger(MeService.name)
    private readonly logger: PinoLogger,
  ) {}

  async getMyWorkspaces(userId: string) {
    const workspaceMemberships = await this.repo.findUserWorkspaceMemberships(userId);

    if (workspaceMemberships.length === 0) {
      return [];
    }

    const workspaceIds = workspaceMemberships.map((m) => m.resourceId);
    const workspaces = await this.repo.findActiveWorkspacesByIds(workspaceIds);

    const roleMap = new Map(workspaceMemberships.map((m) => [m.resourceId, m.role]));

    this.logger.info({ userId, count: workspaces.length }, 'User workspace list fetched');

    return workspaces.map((ws) => ({
      workspaceId: ws.id,
      workspaceName: ws.name,
      companyId: ws.companyId,
      role: roleMap.get(ws.id) ?? 'member',
    }));
  }

  async getProfile(userId: string) {
    const user = await this.repo.findUserById(userId);
    if (!user) throw new NotFoundException('Usuário não encontrado');
    this.logger.info({ userId }, 'Profile fetched');
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const updated = await this.repo.updateUserById(userId, dto);
    this.logger.info({ userId }, 'Profile updated');
    return updated;
  }

  async updatePassword(userId: string, dto: UpdatePasswordDto) {
    const record = await this.repo.findUserPasswordHash(userId);
    if (!record) throw new NotFoundException('Usuário não encontrado');

    const valid = await bcrypt.compare(dto.currentPassword, record.passwordHash);
    if (!valid) throw new UnauthorizedException('Senha atual incorreta');

    const hash = await bcrypt.hash(dto.newPassword, 10);
    await this.repo.updateUserPasswordHash(userId, hash);
    this.logger.info({ userId }, 'Password changed');
  }

  async uploadAvatar(userId: string, file: Express.Multer.File): Promise<{ photoUrl: string }> {
    if (!file) throw new BadRequestException('Nenhum arquivo enviado');
    if (!ALLOWED_MIME.has(file.mimetype))
      throw new UnsupportedMediaTypeException('Formato não suportado');
    if (file.size > 16 * 1024 * 1024)
      throw new BadRequestException('Arquivo muito grande (máx 16 MB)');

    if (!existsSync(AVATARS_ROOT)) mkdirSync(AVATARS_ROOT, { recursive: true });

    const dest = join(AVATARS_ROOT, `${userId}.webp`);
    await sharp(file.buffer).resize(400, 400, { fit: 'cover' }).webp({ quality: 85 }).toFile(dest);

    const photoUrl = `/api/v1/me/foto/${userId}?t=${Date.now()}`;
    await this.repo.updateUserById(userId, { photoUrl });

    this.logger.info({ userId }, 'Avatar uploaded');
    return { photoUrl };
  }

  getAvatarPath(userId: string): string | null {
    const p = join(AVATARS_ROOT, `${userId}.webp`);
    return existsSync(p) ? p : null;
  }

  async getMyTasks(userId: string, dto: ListMyTasksQueryDto) {
    const { companyId, filter, page = 1, limit = 20 } = dto;
    const search = dto.search?.trim() || undefined;
    // Busca por título ignora os filtros de data (procura em todas as datas).
    const dueDateFilter = search ? undefined : this.buildDueDateFilter(dto);
    const startDateFilter = search ? undefined : this.buildStartDateFilter(dto);

    const [data, total] = await Promise.all([
      this.repo.findUserTasksByCompany(
        userId,
        companyId,
        dueDateFilter,
        page,
        limit,
        startDateFilter,
        search,
      ),
      this.repo.countUserTasksByCompany(userId, companyId, dueDateFilter, startDateFilter, search),
    ]);

    this.logger.info({ userId, companyId, filter, search, total }, 'User tasks fetched');
    return { data, total, page, limit };
  }

  private buildStartDateFilter(dto: ListMyTasksQueryDto): { gte?: Date; lte?: Date } | undefined {
    // Limites do dia computados no timezone da app (mesma convenção de
    // armazenamento da task) — evita off-by-one de meia-noite UTC vs setHours local.
    return dayRangeInTz(dto.startDateFrom, dto.startDateTo);
  }

  private buildDueDateFilter(dto: ListMyTasksQueryDto): { gte?: Date; lte?: Date } | undefined {
    if (!dto.filter) return undefined;

    // "Hoje" ancorado ao dia-mural no timezone da app (não no fuso do servidor,
    // que em prod normalmente é UTC), depois aritmética de dias sobre a data.
    const todayStr = formatInTimeZone(new Date(), APP_TIMEZONE, 'yyyy-MM-dd');
    const today = parseISO(todayStr);
    const ymd = (d: Date) => format(d, 'yyyy-MM-dd');

    switch (dto.filter) {
      case TaskDateFilter.TODAY:
        return dayRangeInTz(todayStr, todayStr);

      case TaskDateFilter.TOMORROW: {
        const tomorrow = ymd(addDays(today, 1));
        return dayRangeInTz(tomorrow, tomorrow);
      }

      case TaskDateFilter.THIS_WEEK: {
        const sunday = ymd(addDays(today, 7 - today.getDay()));
        return dayRangeInTz(todayStr, sunday);
      }

      case TaskDateFilter.OVERDUE:
        // Apenas { lte } = fim de ontem no tz da app.
        return dayRangeInTz(undefined, ymd(addDays(today, -1)));

      case TaskDateFilter.CUSTOM:
        return dayRangeInTz(dto.dueDateFrom, dto.dueDateTo);

      default:
        return undefined;
    }
  }

  async getSidebarOrder(userId: string, companyId: string) {
    const [workspaceOrders, projectOrders] = await this.repo.findSidebarOrders(userId, companyId);
    return { workspaceOrders, projectOrders };
  }

  async saveWorkspaceOrder(userId: string, dto: SaveWorkspaceOrderDto) {
    await this.repo.upsertWorkspaceOrder(userId, dto.companyId, dto.workspaceIds);
    this.logger.info({ userId, companyId: dto.companyId }, 'Workspace order saved');
  }

  async saveProjectOrder(userId: string, dto: SaveProjectOrderDto) {
    await this.repo.upsertProjectOrder(userId, dto.workspaceId, dto.projectIds);
    this.logger.info({ userId, workspaceId: dto.workspaceId }, 'Project order saved');
  }

  async getMyCompanies(userId: string) {
    const companyMemberships = await this.repo.findUserCompanyMemberships(userId);
    const workspaceMemberships = await this.repo.findUserWorkspaceMemberships(userId);

    // Mapa workspaceId → role do usuário naquele workspace
    const workspaceRoleMap = new Map(workspaceMemberships.map((m) => [m.resourceId, m.role]));

    let workspacesByCompany: Array<{ id: string; companyId: string }> = [];
    if (workspaceMemberships.length > 0) {
      const workspaceIds = workspaceMemberships.map((m) => m.resourceId);
      workspacesByCompany = await this.repo.findWorkspacesByIds(workspaceIds);
    }

    // Mapa companyId → melhor role do usuário via workspace
    const workspaceRoleByCompany = new Map<string, string>();
    const roleRank: Record<string, number> = { admin: 3, workspace_admin: 2, member: 1 };

    for (const ws of workspacesByCompany) {
      const wsRole = workspaceRoleMap.get(ws.id) ?? 'member';
      const current = workspaceRoleByCompany.get(ws.companyId);
      if (!current || (roleRank[wsRole] ?? 0) > (roleRank[current] ?? 0)) {
        workspaceRoleByCompany.set(ws.companyId, wsRole);
      }
    }

    const directIds = new Set(companyMemberships.map((m) => m.resourceId));
    const allCompanyIds = [
      ...new Set([...directIds, ...workspacesByCompany.map((w) => w.companyId)]),
    ];

    if (allCompanyIds.length === 0) {
      return [];
    }

    const companies = await this.repo.findActiveCompaniesByIds(allCompanyIds);

    this.logger.info({ userId, count: companies.length }, 'User company list fetched');

    return companies
      .map((c) => {
        const directAll = companyMemberships.filter((m) => m.resourceId === c.id);
        const bestDirect = directAll.reduce<string | null>(
          (best, m) => ((roleRank[m.role] ?? 0) > (roleRank[best ?? ''] ?? 0) ? m.role : best),
          null,
        );
        // Prioridade: membership direto na empresa > role via workspace
        const role = bestDirect ?? workspaceRoleByCompany.get(c.id) ?? 'member';
        return { companyId: c.id, legalName: c.legalName, role };
      })
      .sort(
        (a, b) =>
          (roleRank[b.role] ?? 0) - (roleRank[a.role] ?? 0) ||
          a.legalName.localeCompare(b.legalName),
      );
  }
}
