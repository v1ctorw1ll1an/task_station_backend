import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as fs from 'fs';
import sharp from 'sharp';
import { fromZonedTime } from 'date-fns-tz';
import { TaskDateFilter } from './dto/list-my-tasks-query.dto';
import { MeRepository } from './me.repository';
import { MeService } from './me.service';
import { APP_TIMEZONE } from '../common/date-range';

jest.mock('bcryptjs');
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
}));
jest.mock('sharp', () => {
  const chain = {
    resize: jest.fn().mockReturnThis(),
    webp: jest.fn().mockReturnThis(),
    toFile: jest.fn().mockResolvedValue({ size: 1234 }),
  };
  return Object.assign(
    jest.fn(() => chain),
    { __chain: chain },
  );
});

// ── helpers ────────────────────────────────────────────────────────────────────

function makeCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 'company-1',
    legalName: 'Acme Ltda',
    isActive: true,
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<Record<keyof MeRepository, jest.Mock>> = {},
): jest.Mocked<MeRepository> {
  return {
    findUserCompanyMemberships: jest.fn(),
    findUserWorkspaceMemberships: jest.fn(),
    findWorkspacesByIds: jest.fn(),
    findActiveCompaniesByIds: jest.fn(),
    findActiveWorkspacesByIds: jest.fn(),
    findUserById: jest.fn(),
    updateUserById: jest.fn(),
    findUserPasswordHash: jest.fn(),
    updateUserPasswordHash: jest.fn(),
    findUserTasksByCompany: jest.fn(),
    countUserTasksByCompany: jest.fn(),
    findSidebarOrders: jest.fn(),
    upsertWorkspaceOrder: jest.fn(),
    upsertProjectOrder: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<MeRepository>;
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeService(repo: jest.Mocked<MeRepository>) {
  const logger = makeLogger();
  return new MeService(repo, logger as any);
}

// ── getMyCompanies ─────────────────────────────────────────────────────────────

describe('MeService.getMyCompanies', () => {
  it('retorna lista vazia quando usuário não tem memberships', async () => {
    const repo = makeRepo({
      findUserCompanyMemberships: jest.fn().mockResolvedValue([]),
      findUserWorkspaceMemberships: jest.fn().mockResolvedValue([]),
    });
    const service = makeService(repo);
    const result = await service.getMyCompanies('user-1');
    expect(result).toEqual([]);
    expect(repo.findActiveCompaniesByIds).not.toHaveBeenCalled();
  });

  it('retorna empresas via membership direto na empresa', async () => {
    const company = makeCompany();
    const repo = makeRepo({
      findUserCompanyMemberships: jest
        .fn()
        .mockResolvedValue([{ resourceId: 'company-1', role: 'admin' }]),
      findUserWorkspaceMemberships: jest.fn().mockResolvedValue([]),
      findActiveCompaniesByIds: jest.fn().mockResolvedValue([company]),
    });
    const service = makeService(repo);
    const result = await service.getMyCompanies('user-1');
    expect(result).toHaveLength(1);
    expect(result[0].companyId).toBe('company-1');
    expect(result[0].role).toBe('admin');
    expect(result[0].legalName).toBe('Acme Ltda');
  });

  it('retorna empresas via membership em workspace', async () => {
    const company = makeCompany({ id: 'company-2', legalName: 'Beta Ltda' });
    const repo = makeRepo({
      findUserCompanyMemberships: jest.fn().mockResolvedValue([]),
      findUserWorkspaceMemberships: jest
        .fn()
        .mockResolvedValue([{ resourceId: 'ws-1', role: 'workspace_admin' }]),
      findWorkspacesByIds: jest.fn().mockResolvedValue([{ id: 'ws-1', companyId: 'company-2' }]),
      findActiveCompaniesByIds: jest.fn().mockResolvedValue([company]),
    });
    const service = makeService(repo);
    const result = await service.getMyCompanies('user-1');
    expect(result).toHaveLength(1);
    expect(result[0].companyId).toBe('company-2');
    // sem membership direto na empresa → role é 'workspace_admin'
    expect(result[0].role).toBe('workspace_admin');
  });

  it('deduplica empresa quando usuário tem membership direta e via workspace', async () => {
    const company = makeCompany();
    const repo = makeRepo({
      findUserCompanyMemberships: jest
        .fn()
        .mockResolvedValue([{ resourceId: 'company-1', role: 'member' }]),
      findUserWorkspaceMemberships: jest
        .fn()
        .mockResolvedValue([{ resourceId: 'ws-1', role: 'workspace_admin' }]),
      findWorkspacesByIds: jest.fn().mockResolvedValue([{ id: 'ws-1', companyId: 'company-1' }]),
      findActiveCompaniesByIds: jest.fn().mockResolvedValue([company]),
    });
    const service = makeService(repo);
    const result = await service.getMyCompanies('user-1');
    // empresa aparece só uma vez
    expect(result).toHaveLength(1);
    expect(result[0].companyId).toBe('company-1');
    // o role é o da membership direta (não workspace_admin)
    expect(result[0].role).toBe('member');
  });

  it('ordena por role rank: admin > workspace_admin > member', async () => {
    const companies = [
      makeCompany({ id: 'c1', legalName: 'Membro Corp' }),
      makeCompany({ id: 'c2', legalName: 'Admin Corp' }),
      makeCompany({ id: 'c3', legalName: 'WS Admin Corp' }),
    ];
    const repo = makeRepo({
      findUserCompanyMemberships: jest.fn().mockResolvedValue([
        { resourceId: 'c1', role: 'member' },
        { resourceId: 'c2', role: 'admin' },
        { resourceId: 'c3', role: 'member' },
      ]),
      findUserWorkspaceMemberships: jest.fn().mockResolvedValue([]),
      findActiveCompaniesByIds: jest.fn().mockResolvedValue(companies),
    });
    const service = makeService(repo);
    const result = await service.getMyCompanies('user-1');
    expect(result[0].role).toBe('admin');
    expect(result[1].role).toBe('member');
    expect(result[2].role).toBe('member');
  });

  it('ordena alfabeticamente por legalName quando roles são iguais', async () => {
    const companies = [
      makeCompany({ id: 'c1', legalName: 'Zebra Corp' }),
      makeCompany({ id: 'c2', legalName: 'Alpha Corp' }),
    ];
    const repo = makeRepo({
      findUserCompanyMemberships: jest.fn().mockResolvedValue([
        { resourceId: 'c1', role: 'member' },
        { resourceId: 'c2', role: 'member' },
      ]),
      findUserWorkspaceMemberships: jest.fn().mockResolvedValue([]),
      findActiveCompaniesByIds: jest.fn().mockResolvedValue(companies),
    });
    const service = makeService(repo);
    const result = await service.getMyCompanies('user-1');
    expect(result[0].legalName).toBe('Alpha Corp');
    expect(result[1].legalName).toBe('Zebra Corp');
  });

  it('não chama findWorkspacesByIds quando não há workspace memberships', async () => {
    const company = makeCompany();
    const repo = makeRepo({
      findUserCompanyMemberships: jest
        .fn()
        .mockResolvedValue([{ resourceId: 'company-1', role: 'admin' }]),
      findUserWorkspaceMemberships: jest.fn().mockResolvedValue([]),
      findActiveCompaniesByIds: jest.fn().mockResolvedValue([company]),
    });
    const service = makeService(repo);
    await service.getMyCompanies('user-1');
    expect(repo.findWorkspacesByIds).not.toHaveBeenCalled();
  });

  it('retorna vazio quando todas as empresas encontradas foram removidas (inactive)', async () => {
    const repo = makeRepo({
      findUserCompanyMemberships: jest
        .fn()
        .mockResolvedValue([{ resourceId: 'company-1', role: 'admin' }]),
      findUserWorkspaceMemberships: jest.fn().mockResolvedValue([]),
      findActiveCompaniesByIds: jest.fn().mockResolvedValue([]), // empresa inativa/deletada
    });
    const service = makeService(repo);
    const result = await service.getMyCompanies('user-1');
    expect(result).toEqual([]);
  });
});

// ── getMyWorkspaces ────────────────────────────────────────────────────────────

describe('MeService.getMyWorkspaces', () => {
  it('retorna vazio quando usuário não tem workspace memberships', async () => {
    const repo = makeRepo({
      findUserWorkspaceMemberships: jest.fn().mockResolvedValue([]),
    });
    const service = makeService(repo);
    expect(await service.getMyWorkspaces('user-1')).toEqual([]);
    expect(repo.findActiveWorkspacesByIds).not.toHaveBeenCalled();
  });

  it('mapeia workspaces com role do membership', async () => {
    const repo = makeRepo({
      findUserWorkspaceMemberships: jest.fn().mockResolvedValue([
        { resourceId: 'ws-1', role: 'workspace_admin' },
        { resourceId: 'ws-2', role: 'member' },
      ]),
      findActiveWorkspacesByIds: jest.fn().mockResolvedValue([
        { id: 'ws-1', name: 'WS One', companyId: 'c-1' },
        { id: 'ws-2', name: 'WS Two', companyId: 'c-1' },
      ]),
    });
    const service = makeService(repo);
    const result = await service.getMyWorkspaces('user-1');
    expect(result).toEqual([
      { workspaceId: 'ws-1', workspaceName: 'WS One', companyId: 'c-1', role: 'workspace_admin' },
      { workspaceId: 'ws-2', workspaceName: 'WS Two', companyId: 'c-1', role: 'member' },
    ]);
  });

  it('usa role default "member" quando não encontra no mapa', async () => {
    const repo = makeRepo({
      findUserWorkspaceMemberships: jest
        .fn()
        .mockResolvedValue([{ resourceId: 'ws-1', role: 'workspace_admin' }]),
      // findActive retorna ws-2 que não está no map → fallback 'member'
      findActiveWorkspacesByIds: jest
        .fn()
        .mockResolvedValue([{ id: 'ws-2', name: 'Outro', companyId: 'c-1' }]),
    });
    const service = makeService(repo);
    const result = await service.getMyWorkspaces('user-1');
    expect(result[0].role).toBe('member');
  });
});

// ── getProfile ─────────────────────────────────────────────────────────────────

describe('MeService.getProfile', () => {
  it('lança NotFoundException quando user não existe', async () => {
    const repo = makeRepo({ findUserById: jest.fn().mockResolvedValue(null) });
    const service = makeService(repo);
    await expect(service.getProfile('u-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('retorna user quando encontrado', async () => {
    const user = { id: 'u-1', name: 'Alice', email: 'a@x.com' };
    const repo = makeRepo({ findUserById: jest.fn().mockResolvedValue(user) });
    const service = makeService(repo);
    expect(await service.getProfile('u-1')).toBe(user);
  });
});

// ── updateProfile ──────────────────────────────────────────────────────────────

describe('MeService.updateProfile', () => {
  it('repassa DTO ao repo.updateUserById', async () => {
    const updated = { id: 'u-1', name: 'New Name' };
    const repo = makeRepo({ updateUserById: jest.fn().mockResolvedValue(updated) });
    const service = makeService(repo);
    const result = await service.updateProfile('u-1', { name: 'New Name' } as any);
    expect(repo.updateUserById).toHaveBeenCalledWith('u-1', { name: 'New Name' });
    expect(result).toBe(updated);
  });
});

// ── updatePassword ─────────────────────────────────────────────────────────────

describe('MeService.updatePassword', () => {
  beforeEach(() => {
    (bcrypt.compare as jest.Mock).mockReset();
    (bcrypt.hash as jest.Mock).mockReset();
  });

  it('lança NotFoundException quando user não existe', async () => {
    const repo = makeRepo({ findUserPasswordHash: jest.fn().mockResolvedValue(null) });
    const service = makeService(repo);
    await expect(
      service.updatePassword('u-x', { currentPassword: 'a', newPassword: 'b' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lança UnauthorizedException quando senha atual está incorreta', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    const repo = makeRepo({
      findUserPasswordHash: jest.fn().mockResolvedValue({ passwordHash: 'hash-existente' }),
    });
    const service = makeService(repo);
    await expect(
      service.updatePassword('u-1', { currentPassword: 'wrong', newPassword: 'new' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repo.updateUserPasswordHash).not.toHaveBeenCalled();
  });

  it('faz hash da nova senha e persiste quando credenciais válidas', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    (bcrypt.hash as jest.Mock).mockResolvedValue('hash-novo');
    const repo = makeRepo({
      findUserPasswordHash: jest.fn().mockResolvedValue({ passwordHash: 'hash-existente' }),
      updateUserPasswordHash: jest.fn().mockResolvedValue(undefined),
    });
    const service = makeService(repo);
    await service.updatePassword('u-1', { currentPassword: 'old', newPassword: 'new' });
    expect(bcrypt.hash).toHaveBeenCalledWith('new', 10);
    expect(repo.updateUserPasswordHash).toHaveBeenCalledWith('u-1', 'hash-novo');
  });
});

// ── uploadAvatar ───────────────────────────────────────────────────────────────

describe('MeService.uploadAvatar', () => {
  beforeEach(() => {
    (fs.existsSync as jest.Mock).mockReset().mockReturnValue(true);
    (fs.mkdirSync as jest.Mock).mockReset();
    const sharpChain = (sharp as any).__chain;
    sharpChain.resize.mockClear();
    sharpChain.webp.mockClear();
    sharpChain.toFile.mockClear();
    (sharp as unknown as jest.Mock).mockClear();
  });

  it('lança BadRequestException quando arquivo é null', async () => {
    const service = makeService(makeRepo());
    await expect(service.uploadAvatar('u-1', null as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('lança UnsupportedMediaTypeException para mime inválido', async () => {
    const service = makeService(makeRepo());
    const file = { mimetype: 'application/pdf', size: 1000, buffer: Buffer.from('x') } as any;
    await expect(service.uploadAvatar('u-1', file)).rejects.toBeInstanceOf(
      UnsupportedMediaTypeException,
    );
  });

  it('lança BadRequestException quando arquivo > 16MB', async () => {
    const service = makeService(makeRepo());
    const file = {
      mimetype: 'image/jpeg',
      size: 17 * 1024 * 1024,
      buffer: Buffer.from('x'),
    } as any;
    await expect(service.uploadAvatar('u-1', file)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('processa imagem com sharp e atualiza photoUrl no repo', async () => {
    const repo = makeRepo({ updateUserById: jest.fn().mockResolvedValue({}) });
    const service = makeService(repo);
    const file = {
      mimetype: 'image/png',
      size: 1000,
      buffer: Buffer.from('img'),
    } as any;

    const result = await service.uploadAvatar('u-1', file);

    const chain = (sharp as any).__chain;
    expect(sharp).toHaveBeenCalledWith(file.buffer);
    expect(chain.resize).toHaveBeenCalledWith(400, 400, { fit: 'cover' });
    expect(chain.webp).toHaveBeenCalledWith({ quality: 85 });
    expect(chain.toFile).toHaveBeenCalled();
    expect(repo.updateUserById).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ photoUrl: expect.stringMatching(/^\/api\/v1\/me\/foto\/u-1\?t=/) }),
    );
    expect(result.photoUrl).toMatch(/^\/api\/v1\/me\/foto\/u-1\?t=/);
  });

  it('cria diretório de avatars quando ele não existe', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const repo = makeRepo({ updateUserById: jest.fn().mockResolvedValue({}) });
    const service = makeService(repo);
    await service.uploadAvatar('u-1', {
      mimetype: 'image/jpeg',
      size: 100,
      buffer: Buffer.from('x'),
    } as any);
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });
});

// ── getAvatarPath ──────────────────────────────────────────────────────────────

describe('MeService.getAvatarPath', () => {
  it('retorna path quando arquivo existe', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const service = makeService(makeRepo());
    expect(service.getAvatarPath('u-1')).toMatch(/u-1\.webp$/);
  });

  it('retorna null quando arquivo não existe', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const service = makeService(makeRepo());
    expect(service.getAvatarPath('u-1')).toBeNull();
  });
});

// ── getMyTasks (filtros de data) ───────────────────────────────────────────────

describe('MeService.getMyTasks', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-15T10:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('retorna { data, total, page, limit } com paginação', async () => {
    const repo = makeRepo({
      findUserTasksByCompany: jest.fn().mockResolvedValue([{ id: 't-1' }]),
      countUserTasksByCompany: jest.fn().mockResolvedValue(1),
    });
    const service = makeService(repo);
    const result = await service.getMyTasks('u-1', { companyId: 'c-1', page: 2, limit: 5 } as any);
    expect(result).toEqual({ data: [{ id: 't-1' }], total: 1, page: 2, limit: 5 });
  });

  it('aplica defaults page=1 limit=20 quando não fornecido', async () => {
    const repo = makeRepo({
      findUserTasksByCompany: jest.fn().mockResolvedValue([]),
      countUserTasksByCompany: jest.fn().mockResolvedValue(0),
    });
    const service = makeService(repo);
    const result = await service.getMyTasks('u-1', { companyId: 'c-1' } as any);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
  });

  it('filter=TODAY repassa { gte, lte } referente ao dia de hoje', async () => {
    const findUserTasks = jest.fn().mockResolvedValue([]);
    const repo = makeRepo({
      findUserTasksByCompany: findUserTasks,
      countUserTasksByCompany: jest.fn().mockResolvedValue(0),
    });
    const service = makeService(repo);
    await service.getMyTasks('u-1', {
      companyId: 'c-1',
      filter: TaskDateFilter.TODAY,
    } as any);
    const filter = findUserTasks.mock.calls[0][2];
    expect(filter.gte).toBeInstanceOf(Date);
    expect(filter.lte).toBeInstanceOf(Date);
  });

  it('filter=OVERDUE produz apenas { lte } (até ontem fim do dia)', async () => {
    const findUserTasks = jest.fn().mockResolvedValue([]);
    const repo = makeRepo({
      findUserTasksByCompany: findUserTasks,
      countUserTasksByCompany: jest.fn().mockResolvedValue(0),
    });
    const service = makeService(repo);
    await service.getMyTasks('u-1', {
      companyId: 'c-1',
      filter: TaskDateFilter.OVERDUE,
    } as any);
    const filter = findUserTasks.mock.calls[0][2];
    expect(filter.lte).toBeInstanceOf(Date);
    expect(filter.gte).toBeUndefined();
  });

  it('filter=CUSTOM sem datas retorna undefined', async () => {
    const findUserTasks = jest.fn().mockResolvedValue([]);
    const repo = makeRepo({
      findUserTasksByCompany: findUserTasks,
      countUserTasksByCompany: jest.fn().mockResolvedValue(0),
    });
    const service = makeService(repo);
    await service.getMyTasks('u-1', {
      companyId: 'c-1',
      filter: TaskDateFilter.CUSTOM,
    } as any);
    expect(findUserTasks.mock.calls[0][2]).toBeUndefined();
  });

  it('filter=CUSTOM com dueDateFrom/To gera filtro', async () => {
    const findUserTasks = jest.fn().mockResolvedValue([]);
    const repo = makeRepo({
      findUserTasksByCompany: findUserTasks,
      countUserTasksByCompany: jest.fn().mockResolvedValue(0),
    });
    const service = makeService(repo);
    await service.getMyTasks('u-1', {
      companyId: 'c-1',
      filter: TaskDateFilter.CUSTOM,
      dueDateFrom: '2026-05-01',
      dueDateTo: '2026-05-31',
    } as any);
    const filter = findUserTasks.mock.calls[0][2];
    // Limite computado no tz da app (não meia-noite UTC) — vide dayRangeInTz.
    expect(filter.gte).toEqual(fromZonedTime('2026-05-01T00:00:00.000', APP_TIMEZONE));
    expect(filter.lte).toBeInstanceOf(Date);
  });

  it('startDateFrom/To gera filtro de startDate separado', async () => {
    const findUserTasks = jest.fn().mockResolvedValue([]);
    const repo = makeRepo({
      findUserTasksByCompany: findUserTasks,
      countUserTasksByCompany: jest.fn().mockResolvedValue(0),
    });
    const service = makeService(repo);
    await service.getMyTasks('u-1', {
      companyId: 'c-1',
      startDateFrom: '2026-05-01',
      startDateTo: '2026-05-31',
    } as any);
    const startFilter = findUserTasks.mock.calls[0][5];
    expect(startFilter.gte).toEqual(fromZonedTime('2026-05-01T00:00:00.000', APP_TIMEZONE));
    expect(startFilter.lte).toBeInstanceOf(Date);
  });

  it('sem dueDate e sem startDate: ambos os filtros são undefined', async () => {
    const findUserTasks = jest.fn().mockResolvedValue([]);
    const repo = makeRepo({
      findUserTasksByCompany: findUserTasks,
      countUserTasksByCompany: jest.fn().mockResolvedValue(0),
    });
    const service = makeService(repo);
    await service.getMyTasks('u-1', { companyId: 'c-1' } as any);
    expect(findUserTasks.mock.calls[0][2]).toBeUndefined();
    expect(findUserTasks.mock.calls[0][5]).toBeUndefined();
  });
});

// ── sidebar order ──────────────────────────────────────────────────────────────

describe('MeService.getSidebarOrder', () => {
  it('retorna { workspaceOrders, projectOrders }', async () => {
    const repo = makeRepo({
      findSidebarOrders: jest
        .fn()
        .mockResolvedValue([[{ workspaceId: 'ws-1' }], [{ projectId: 'p-1' }]]),
    });
    const service = makeService(repo);
    expect(await service.getSidebarOrder('u-1', 'c-1')).toEqual({
      workspaceOrders: [{ workspaceId: 'ws-1' }],
      projectOrders: [{ projectId: 'p-1' }],
    });
    expect(repo.findSidebarOrders).toHaveBeenCalledWith('u-1', 'c-1');
  });
});

describe('MeService.saveWorkspaceOrder', () => {
  it('repassa companyId e workspaceIds ao upsert', async () => {
    const repo = makeRepo({ upsertWorkspaceOrder: jest.fn().mockResolvedValue(undefined) });
    const service = makeService(repo);
    await service.saveWorkspaceOrder('u-1', {
      companyId: 'c-1',
      workspaceIds: ['ws-1', 'ws-2'],
    } as any);
    expect(repo.upsertWorkspaceOrder).toHaveBeenCalledWith('u-1', 'c-1', ['ws-1', 'ws-2']);
  });
});

describe('MeService.saveProjectOrder', () => {
  it('repassa workspaceId e projectIds ao upsert', async () => {
    const repo = makeRepo({ upsertProjectOrder: jest.fn().mockResolvedValue(undefined) });
    const service = makeService(repo);
    await service.saveProjectOrder('u-1', {
      workspaceId: 'ws-1',
      projectIds: ['p-1', 'p-2'],
    } as any);
    expect(repo.upsertProjectOrder).toHaveBeenCalledWith('u-1', 'ws-1', ['p-1', 'p-2']);
  });
});
