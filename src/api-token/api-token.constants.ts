/**
 * Prefixo de todo token de acesso pessoal. É ele que separa, no `JwtAuthGuard`,
 * um PAT de um JWT de sessão — e facilita achar token vazado em log ou repositório.
 */
export const API_TOKEN_PREFIX = 'tdy_';

/** Quantos caracteres do token em claro ficam guardados para exibição (`tdy_abcd1234`). */
export const API_TOKEN_DISPLAY_LENGTH = 12;

/**
 * Tamanho máximo aceito no header antes de calcular hash. O token real tem 47
 * caracteres (`tdy_` + 43 de base64url); acima disso é lixo e nem vai ao banco.
 */
export const API_TOKEN_MAX_LENGTH = 100;

/** `lastUsedAt` é gravado no máximo uma vez por janela, para não escrever a cada request. */
export const API_TOKEN_LAST_USED_RESOLUTION_MS = 60_000;

/** O que o `JwtAuthGuard` pendura na request quando a autenticação veio de um PAT. */
export interface ApiTokenContext {
  id: string;
  workspaceId: string;
}
