/**
 * Regras puras da sincronização — sem Prisma nem Google, para testar sem mock.
 */

/** Para onde a sincronização corre (controle global do superusuário). */
export type SyncDirection = 'both' | 'google_to_app' | 'app_to_google';

export const SYNC_DIRECTIONS: readonly SyncDirection[] = [
  'both',
  'google_to_app',
  'app_to_google',
] as const;

/** O TaskDY escreve no Google (criar, atualizar, reverter, remover cópias)? */
export function isPushAllowed(direction: SyncDirection): boolean {
  return direction !== 'google_to_app';
}

/** Mudanças feitas no Google entram no TaskDY? */
export function isPullAllowed(direction: SyncDirection): boolean {
  return direction !== 'app_to_google';
}

export type RemoteDecision =
  /** A mudança é o nosso próprio push voltando (mesmo etag). */
  | 'echo'
  /** Empresa não elegível: item congelado, edição remota ignorada (Q18). */
  | 'ignore_frozen'
  /** Cópia somente-leitura (convidado, tarefa, série sem tradução): desfaz no Google. */
  | 'revert'
  /** Conflito e o TaskDY editou por último: reenvia o local por cima (Q8). */
  | 'push_local'
  /** Aplica a mudança do Google no TaskDY. */
  | 'apply_remote'
  /** Só Google → TaskDY e a cópia não pode mudar aqui: nada a fazer (nem reverter). */
  | 'ignore_direction';

export interface RemoteChangeInput {
  remoteEtag: string | null | undefined;
  linkEtag: string | null | undefined;
  frozen: boolean;
  readOnly: boolean;
  localUpdatedAt: Date;
  /** `updatedAt` local no último sync; null = nunca sincronizado (reatar, Q19). */
  linkLocalUpdatedAt: Date | null;
  /** `updated` do evento no Google. */
  remoteUpdated: Date | null;
  /** Ausente = 'both'. */
  direction?: SyncDirection;
}

/**
 * Última edição vence (Q8): só há conflito quando os dois lados mudaram desde o
 * último sync; aí compara `updatedAt` do TaskDY com `updated` do Google.
 *
 * Direção única: só TaskDY → Google trata toda cópia como somente-leitura (reverte);
 * só Google → TaskDY nunca escreve no Google — aplica o remoto ou ignora.
 */
export function decideRemoteChange(i: RemoteChangeInput): RemoteDecision {
  const direction = i.direction ?? 'both';
  if (i.remoteEtag && i.linkEtag && i.remoteEtag === i.linkEtag) return 'echo';
  if (i.frozen) return 'ignore_frozen';
  if (i.readOnly || !isPullAllowed(direction)) {
    return isPushAllowed(direction) ? 'revert' : 'ignore_direction';
  }
  if (!isPushAllowed(direction)) return 'apply_remote';
  const localChanged =
    !i.linkLocalUpdatedAt || i.localUpdatedAt.getTime() > i.linkLocalUpdatedAt.getTime();
  if (localChanged && i.remoteUpdated && i.localUpdatedAt.getTime() > i.remoteUpdated.getTime()) {
    return 'push_local';
  }
  return 'apply_remote';
}

export interface PushInput {
  force: boolean;
  hasLink: boolean;
  localUpdatedAt: Date;
  linkLocalUpdatedAt: Date | null;
  linkReadOnly: boolean;
  readOnly: boolean;
}

/**
 * Evita eco e trabalho à toa: sem mudança local desde o último push (e sem mudança
 * de permissão), não há o que mandar.
 */
export function shouldPush(i: PushInput): boolean {
  if (i.force || !i.hasLink || !i.linkLocalUpdatedAt) return true;
  if (i.linkReadOnly !== i.readOnly) return true;
  return i.localUpdatedAt.getTime() > i.linkLocalUpdatedAt.getTime();
}

/** Papéis do Google que permitem editar o evento no calendário de origem (Q9). */
export function isWritableAccessRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'writer';
}

/** Backoff do outbox: 1, 2, 4… min, teto de 1 h. */
export function nextRetryDelayMs(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;
}

export const MAX_JOB_ATTEMPTS = 8;
