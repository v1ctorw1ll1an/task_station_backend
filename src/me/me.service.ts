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
    const dueDateFilter = this.buildDueDateFilter(dto);

    const [data, total] = await Promise.all([
      this.repo.findUserTasksByCompany(userId, companyId, dueDateFilter, page, limit),
      this.repo.countUserTasksByCompany(userId, companyId, dueDateFilter),
    ]);

    this.logger.info({ userId, companyId, filter, total }, 'User tasks fetched');
    return { data, total, page, limit };
  }

  private buildDueDateFilter(dto: ListMyTasksQueryDto): { gte?: Date; lte?: Date } | undefined {
    if (!dto.filter) return undefined;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const endOfDay = (d: Date) => {
      const end = new Date(d);
      end.setHours(23, 59, 59, 999);
      return end;
    };

    switch (dto.filter) {
      case TaskDateFilter.TODAY:
        return { gte: today, lte: endOfDay(today) };

      case TaskDateFilter.TOMORROW: {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        return { gte: tomorrow, lte: endOfDay(tomorrow) };
      }

      case TaskDateFilter.THIS_WEEK: {
        const sunday = new Date(today);
        sunday.setDate(sunday.getDate() + (7 - sunday.getDay()));
        return { gte: today, lte: endOfDay(sunday) };
      }

      case TaskDateFilter.OVERDUE: {
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        return { lte: endOfDay(yesterday) };
      }

      case TaskDateFilter.CUSTOM: {
        const result: { gte?: Date; lte?: Date } = {};
        if (dto.dueDateFrom) result.gte = new Date(dto.dueDateFrom);
        if (dto.dueDateTo) {
          const to = new Date(dto.dueDateTo);
          result.lte = endOfDay(to);
        }
        return Object.keys(result).length > 0 ? result : undefined;
      }

      default:
        return undefined;
    }
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
