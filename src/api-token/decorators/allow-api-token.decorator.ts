import { SetMetadata } from '@nestjs/common';

export const ALLOW_API_TOKEN_KEY = 'allowApiToken';

/**
 * Libera a rota para requests autenticadas por token de acesso pessoal (PAT).
 *
 * Sem este decorator, o `ApiTokenScopeGuard` recusa o PAT — rota nova nasce
 * bloqueada para o Claude. Só vale no **handler** (não no controller), para que cada
 * rota seja uma decisão explícita. A lista inteira é conferida em
 * `test/api-token-coverage.e2e-spec.ts`; nenhuma rota `DELETE` pode entrar.
 */
export const AllowApiToken = () => SetMetadata(ALLOW_API_TOKEN_KEY, true);
