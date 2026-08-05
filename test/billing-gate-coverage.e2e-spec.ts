import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { IS_PUBLIC_KEY } from './../src/auth/decorators/public.decorator';
import { SKIP_BILLING_GATE_KEY } from './../src/billing/decorators/skip-billing-gate.decorator';

jest.setTimeout(60_000);

/**
 * Somente-leitura só é sustentável se a cobertura for **garantida**, não lembrada.
 *
 * O `BillingGateGuard` bloqueia mutação resolvendo a empresa pelos params da rota
 * (`:companyId`/`:workspaceId`/`:projectId`). Rota de escrita sem esse escopo passa
 * batido **em silêncio** — e ninguém percebe até a empresa bloqueada estar gravando.
 *
 * Este teste varre TODAS as rotas de mutação e exige que cada uma esteja em uma de
 * três categorias. Rota nova sem classificação = CI vermelho, com o nome do handler
 * na mensagem. Se você chegou aqui por causa de uma falha: escolha conscientemente
 * onde a sua rota entra e registre abaixo — não "conserte" apagando o teste.
 */

/** Escopos que o gate sabe resolver sozinho (ver `billing-gate.guard.ts`). */
const PARAMS_COM_ESCOPO = [':companyId', ':workspaceId', ':projectId'];

const METODOS_DE_MUTACAO = [
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
];

/**
 * Rotas que **não** devem ser bloqueadas por cobrança, com o motivo. Se o motivo
 * não valer mais, a rota sai daqui e passa a ser barrada.
 */
const ISENTAS: Record<string, string> = {
  'POST /auth/login': 'entrar no sistema não pode depender de cobrança',
  'POST /auth/logout': 'sair sempre tem que funcionar',
  'POST /auth/register': 'auto-cadastro cria a empresa; não existe cobrança ainda',
  'POST /auth/register-colaborador':
    'cria conta sem empresa nenhuma; não há empresa a que a cobrança se aplique',
  'POST /auth/first-access': 'primeiro acesso define a senha de quem foi convidado',
  'POST /auth/forgot-password': 'recuperação de senha é anterior a qualquer cobrança',
  'POST /auth/reset-password': 'recuperação de senha é anterior a qualquer cobrança',
  'POST /auth/reset-password/:token': 'recuperação de senha é anterior a qualquer cobrança',
  'POST /billing/webhook': 'é o Asaas nos avisando de pagamento — bloquear seria absurdo',
  'PATCH /me/perfil': 'perfil é do usuário, não da empresa',
  'PATCH /me/perfil/senha': 'trocar a própria senha não pode depender de cobrança',
  'POST /me/perfil/foto': 'foto de perfil é do usuário, não da empresa',
  'POST /me/tutorial/concluir':
    'marcar o próprio tutorial como visto é preferência de tela do usuário',
  'PUT /me/workspace-order': 'ordem da barra lateral é preferência de tela do usuário',
  'PUT /me/project-order': 'ordem da barra lateral é preferência de tela do usuário',
  'PATCH /me/notificacoes/:id/read': 'marcar a própria notificação como lida é do usuário',
  'PATCH /me/notificacoes/read-all': 'marcar as próprias notificações como lidas é do usuário',
  'PATCH /me/notificacoes/preferencias': 'preferência de notificação é do usuário',
  'DELETE /me/notificacoes/:id': 'notificação é do usuário',
  'DELETE /me/notificacoes': 'limpar as próprias notificações é do usuário',
  'POST /me/sticky-notes': 'recado pessoal, não é dado da empresa',
  'PATCH /me/sticky-notes/:id': 'recado pessoal, não é dado da empresa',
  'DELETE /me/sticky-notes/:id': 'recado pessoal, não é dado da empresa',
  'POST /me/sticky-notes/:id/tasks/:taskId':
    'vínculo do recado pessoal com uma task; não altera a task',
  'DELETE /me/sticky-notes/:id/tasks/:taskId':
    'vínculo do recado pessoal com uma task; não altera a task',
  'PATCH /me/calendar-events/:id/rsvp': 'responder convite é do convidado, não escrita da empresa',
  'POST /uploads/image':
    'só guarda o arquivo; publicar o comunicado passa por empresa/:companyId, que é barrado',
};

/**
 * Rotas cujo escopo só aparece no corpo/no recurso — o bloqueio é feito **dentro**
 * do fluxo, com `BillingAccessService.assertNotBlocked`. Mantenha o ponteiro para
 * onde a checagem mora; se ela sumir de lá, o bloqueio some junto.
 */
const TRATADAS_NO_FLUXO: Record<string, string> = {
  'POST /me/calendar-events': 'evento.service.ts → assertNotBlocked(empresa do evento)',
  'PATCH /me/calendar-events/:id': 'evento.service.ts → assertNotBlocked',
  'DELETE /me/calendar-events/:id': 'evento.service.ts → assertNotBlocked',
  'POST /me/calendar-events/:id/attendees': 'evento.service.ts → assertNotBlocked',
  'DELETE /me/calendar-events/:id/attendees/:userId': 'evento.service.ts → assertNotBlocked',
  'POST /convites/:token/aceitar':
    'convite.service.ts → getSummary(empresa do convite) recusa suspensa + assertSeatAvailable',
  'POST /task-sessions': 'task-session.service.ts → assertNotBlocked(empresa da task)',
  'PATCH /task-sessions/:id/pause': 'task-session.service.ts → assertNotBlocked',
  'PATCH /task-sessions/:id/resume': 'task-session.service.ts → assertNotBlocked',
  'PATCH /task-sessions/:id/stop': 'task-session.service.ts → assertNotBlocked',
};

/** Prefixos de rota exclusivos do superusuário — o gate já libera `isSuperuser`. */
const PREFIXOS_SUPERADMIN = ['superadmin'];

/** O link público de convidado é barrado no `GuestTokenGuard` (não-GET + empresa bloqueada). */
const PREFIXO_CONVIDADO = 'public/tasks/:token';

interface Rota {
  chave: string;
  controller: string;
}

function normalizar(...partes: (string | undefined)[]): string {
  return `/${partes.filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

const NOME_DO_METODO: Record<number, string> = {
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

describe('Cobertura do gate de cobrança', () => {
  let moduleRef: TestingModule;
  let rotas: Rota[];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const discovery = moduleRef.get(DiscoveryService);
    const scanner = new MetadataScanner();

    rotas = [];
    for (const wrapper of discovery.getControllers()) {
      const instance = wrapper.instance as object | undefined;
      if (!instance || !wrapper.metatype) continue;
      const proto = Object.getPrototypeOf(instance) as object;
      const caminhoDoController = Reflect.getMetadata(PATH_METADATA, wrapper.metatype) as string;

      for (const nomeDoMetodo of scanner.getAllMethodNames(proto)) {
        const handler = (proto as Record<string, unknown>)[nomeDoMetodo] as
          | ((...args: unknown[]) => unknown)
          | undefined;
        if (typeof handler !== 'function') continue;

        const verbo = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (verbo === undefined || !METODOS_DE_MUTACAO.includes(verbo)) continue;

        const caminhoDoHandler = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        const caminho = normalizar(caminhoDoController, caminhoDoHandler);
        const isento =
          Reflect.getMetadata(SKIP_BILLING_GATE_KEY, handler) === true ||
          Reflect.getMetadata(SKIP_BILLING_GATE_KEY, wrapper.metatype) === true ||
          Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true ||
          Reflect.getMetadata(IS_PUBLIC_KEY, wrapper.metatype) === true;

        rotas.push({
          chave: `${NOME_DO_METODO[verbo]} ${caminho}`,
          controller: `${wrapper.metatype.name}.${nomeDoMetodo}${isento ? ' (isenta)' : ''}`,
        });
      }
    }
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('encontra as rotas de mutação da aplicação', () => {
    // Sanidade: se a varredura quebrar, o teste inteiro viraria um falso "tudo ok".
    expect(rotas.length).toBeGreaterThan(50);
  });

  it('toda rota de mutação está classificada (gate, isenção declarada ou fluxo)', () => {
    const semClassificacao = rotas.filter(({ chave }) => {
      const [, caminho] = chave.split(' ');
      if (PARAMS_COM_ESCOPO.some((p) => caminho.includes(p))) return false; // o gate resolve
      if (caminho.startsWith(`/${PREFIXO_CONVIDADO}`)) return false; // GuestTokenGuard
      if (PREFIXOS_SUPERADMIN.some((p) => caminho.startsWith(`/${p}`))) return false;
      if (ISENTAS[chave] || TRATADAS_NO_FLUXO[chave]) return false;
      return true;
    });

    expect(
      semClassificacao.map((r) => `${r.chave}  [${r.controller}]`).sort(),
      // Mensagem que aparece no CI:
      // decida onde a rota entra e registre em ISENTAS ou TRATADAS_NO_FLUXO,
      // ou coloque o escopo da empresa no path para o gate cobrir sozinho.
    ).toEqual([]);
  });

  it('não sobra registro velho nas listas (rota que deixou de existir)', () => {
    const existentes = new Set(rotas.map((r) => r.chave));
    const orfas = [...Object.keys(ISENTAS), ...Object.keys(TRATADAS_NO_FLUXO)].filter(
      (chave) => !existentes.has(chave),
    );
    expect(orfas.sort()).toEqual([]);
  });

  it('toda isenção tem motivo escrito', () => {
    const semMotivo = Object.entries({ ...ISENTAS, ...TRATADAS_NO_FLUXO })
      .filter(([, motivo]) => motivo.trim().length < 15)
      .map(([chave]) => chave);
    expect(semMotivo).toEqual([]);
  });
});
