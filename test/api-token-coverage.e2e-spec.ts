import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { ALLOW_API_TOKEN_KEY } from './../src/api-token/decorators/allow-api-token.decorator';

jest.setTimeout(60_000);

/**
 * O que um token de acesso pessoal (o Claude, via MCP) pode fazer é **esta lista**.
 *
 * O `ApiTokenScopeGuard` recusa o token em toda rota sem `@AllowApiToken()`. Este teste
 * garante que ninguém liberou uma rota por engano: qualquer rota a mais ou a menos
 * quebra o CI. Se você chegou aqui por causa de uma falha, a decisão é consciente —
 * o token vai poder fazer isso em nome do usuário, sem ele estar olhando.
 *
 * Regras fixas, que este teste também cobra:
 * - nenhuma rota `DELETE` (o token lê e edita, não exclui);
 * - o decorator vale só no handler, nunca no controller inteiro;
 * - toda rota liberada tem escopo de workspace (`:workspaceId` ou `:projectId`),
 *   exceto as listadas em `SEM_ESCOPO`.
 */
const LIBERADAS = [
  'GET /me/api-tokens/current',

  'GET /workspace/:workspaceId',
  'GET /workspace/:workspaceId/projetos',
  'GET /workspace/:workspaceId/projetos/:projectId',
  'GET /workspace/:workspaceId/visao-geral',
  'GET /workspace/:workspaceId/task/:taskRef',
  // Criar projeto: só onde o usuário é admin do workspace (WorkspaceAdminGuard).
  'POST /workspace/:workspaceId/projetos',

  'GET /projetos/:projectId/kanban',
  'GET /projetos/:projectId/colunas/:columnId/tasks',
  'GET /projetos/:projectId/membros',
  'GET /projetos/:projectId/labels',

  'POST /projetos/:projectId/tasks',
  'GET /projetos/:projectId/tasks/:taskId',
  'PATCH /projetos/:projectId/tasks/:taskId',
  'PATCH /projetos/:projectId/tasks/:taskId/move',
  'PATCH /projetos/:projectId/tasks/:taskId/assign',
  'GET /projetos/:projectId/tasks/:taskId/history',

  'GET /projetos/:projectId/tasks/:taskId/checklists',
  'POST /projetos/:projectId/tasks/:taskId/checklists',
  'PATCH /projetos/:projectId/tasks/:taskId/checklists/:checklistId',

  'GET /projetos/:projectId/tasks/:taskId/comments',
  'POST /projetos/:projectId/tasks/:taskId/comments',
  'PATCH /projetos/:projectId/tasks/:taskId/comments/:commentId',
];

/** Liberadas sem escopo de workspace no path — com o motivo de não precisarem. */
const SEM_ESCOPO: Record<string, string> = {
  'GET /me/api-tokens/current': 'só descreve o próprio token (o service confere o vínculo)',
};

const NOME_DO_METODO: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.ALL]: 'ALL',
};

function normalizar(...partes: (string | undefined)[]): string {
  return `/${partes.filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

describe('Cobertura do token de acesso pessoal (@AllowApiToken)', () => {
  let moduleRef: TestingModule;
  let liberadas: string[];
  let controllersMarcados: string[];
  let totalDeRotas: number;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const discovery = moduleRef.get(DiscoveryService);
    const scanner = new MetadataScanner();

    liberadas = [];
    controllersMarcados = [];
    totalDeRotas = 0;
    for (const wrapper of discovery.getControllers()) {
      const instance = wrapper.instance as object | undefined;
      if (!instance || !wrapper.metatype) continue;
      if (Reflect.getMetadata(ALLOW_API_TOKEN_KEY, wrapper.metatype) !== undefined) {
        controllersMarcados.push(wrapper.metatype.name);
      }
      const proto = Object.getPrototypeOf(instance) as object;
      const caminhoDoController = Reflect.getMetadata(PATH_METADATA, wrapper.metatype) as string;

      for (const nomeDoMetodo of scanner.getAllMethodNames(proto)) {
        const handler = (proto as Record<string, unknown>)[nomeDoMetodo] as
          | ((...args: unknown[]) => unknown)
          | undefined;
        if (typeof handler !== 'function') continue;

        const verbo = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (verbo === undefined) continue;
        totalDeRotas++;

        if (Reflect.getMetadata(ALLOW_API_TOKEN_KEY, handler) !== true) continue;
        const caminhoDoHandler = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        liberadas.push(
          `${NOME_DO_METODO[verbo]} ${normalizar(caminhoDoController, caminhoDoHandler)}`,
        );
      }
    }
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('encontra as rotas da aplicação', () => {
    // Sanidade: se a varredura quebrar, o teste viraria um falso "tudo ok".
    expect(totalDeRotas).toBeGreaterThan(100);
  });

  it('o conjunto de rotas liberadas é exatamente o revisado', () => {
    expect([...liberadas].sort()).toEqual([...LIBERADAS].sort());
  });

  it('nenhuma rota DELETE é liberada para token', () => {
    expect(liberadas.filter((r) => r.startsWith('DELETE ') || r.startsWith('ALL '))).toEqual([]);
  });

  it('o decorator nunca é aplicado no controller inteiro', () => {
    expect(controllersMarcados).toEqual([]);
  });

  it('toda rota liberada tem escopo de workspace, ou motivo para não ter', () => {
    const semEscopo = liberadas.filter(
      (r) => !r.includes(':workspaceId') && !r.includes(':projectId') && !SEM_ESCOPO[r],
    );
    expect(semEscopo).toEqual([]);
  });

  it('nenhuma rota liberada é de empresa', () => {
    expect(liberadas.filter((r) => r.includes(':companyId'))).toEqual([]);
  });
});
