/**
 * Limites de produto por plano.
 *
 * Esses valores são o **limite de UX/produto** (o que o usuário pode escrever),
 * NÃO o limite de segurança contra DoS. O limite de DoS continua sendo o body
 * cap do Express (1 MB, em main.ts).
 *
 * Como isso vira tier-aware no futuro:
 *
 *   import { LIMITS, type Plan } from './limits';
 *
 *   function getLimits(plan: Plan) {
 *     return LIMITS[plan];
 *   }
 *
 *   // No service, depois de carregar o usuário:
 *   const max = getLimits(user.plan).comment;
 *   if (content.length > max) throw new BadRequestException(...);
 *
 * Hoje os DTOs validam com `@MaxLength(LIMITS.free.X)` — limite menos
 * generoso. Quando o tier for por usuário, vamos remover o `@MaxLength`
 * estático e validar no service contra `getLimits(req.user.plan)`.
 */
export type Plan = 'free' | 'pro';

interface TierLimits {
  taskTitle: number;
  taskDescription: number;
  comment: number;
  checklistItem: number;
  broadcastTitle: number;
  broadcastBody: number;
  stickyNote: number;
  entityName: number; // empresa / workspace / projeto
  // Caps de volume (quantidade) — anti-abuso por spam.
  mentionsPerComment: number;
  guestsPerTask: number;
}

export const LIMITS: Record<Plan, TierLimits> = {
  free: {
    taskTitle: 120,
    taskDescription: 8_000,
    comment: 250,
    checklistItem: 120,
    broadcastTitle: 120,
    broadcastBody: 500,
    stickyNote: 255,
    entityName: 80,
    mentionsPerComment: 10,
    guestsPerTask: 20,
  },
  pro: {
    taskTitle: 255,
    taskDescription: 10_000,
    comment: 2_000,
    checklistItem: 500,
    broadcastTitle: 200,
    broadcastBody: 5_000,
    stickyNote: 1_000,
    entityName: 120,
    mentionsPerComment: 25,
    guestsPerTask: 100,
  },
};

/** Atalho enquanto não há tier por usuário — todos hoje são "free". */
export const FREE = LIMITS.free;

/**
 * Cap de retenção do histórico de alterações por task (ring buffer).
 * Mantém apenas as N entradas (`TaskHistory`) mais recentes — as mais antigas
 * são deletadas (hard delete) conforme novas entram. NÃO é tier-aware.
 * Espelhado em `frontend/lib/limits.ts`.
 */
export const TASK_HISTORY_MAX = 15;

/**
 * Tamanho da senha. NÃO é tier-aware — vale para todo fluxo que define ou troca
 * senha (ativação por magic link, esqueci-a-senha, troca obrigatória, perfil e
 * superadmin). Ficava repetido como literal em 6 DTOs, que foi exatamente como
 * os fluxos divergiram; qualquer mudança agora entra aqui e no espelho
 * `frontend/lib/limits.ts`.
 *
 * O máximo é 72 por limitação do bcrypt (bytes além disso são ignorados).
 */
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 72;
