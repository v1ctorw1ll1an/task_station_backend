// Helpers compartilhados por todos os scripts de loadtest.
// Variáveis de ambiente esperadas:
//   BASE_URL  — default http://localhost:6969/api/v1
//   EMAIL     — default admin@taskdy.com
//   PASSWORD  — default Admin@123456
import http from 'k6/http';
import { fail } from 'k6';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:6969/api/v1';
const EMAIL = __ENV.EMAIL || 'admin@taskdy.com';
const PASSWORD = __ENV.PASSWORD || 'Admin@123456';

/**
 * Faz login uma vez (no setup) e devolve o JWT.
 * Importante: chamar SÓ no `setup()`, nunca dentro do default — senão cada
 * VU faz login e estoura o throttle de 5 req/min do /auth/login.
 */
export function login() {
  const r = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, timeout: '10s' },
  );

  // status 0 = falha de conexão (servidor fora do ar, DNS, firewall)
  if (r.status === 0) {
    fail(
      `Não consegui conectar em ${BASE_URL}. ` +
        `Verifique se o backend está rodando (pnpm run start:dev) ` +
        `e se BASE_URL=${BASE_URL} está correto. ` +
        `error_code=${r.error_code} error="${r.error}"`,
    );
  }

  if (r.status === 429) {
    fail(
      `Login bloqueado por throttle (429). Aguarde 60s e tente de novo, ` +
        `ou reinicie o backend para resetar o contador.`,
    );
  }

  if (r.status !== 200 && r.status !== 201) {
    fail(
      `Login falhou em ${BASE_URL}/auth/login com status=${r.status}. ` +
        `Body: ${r.body}. Verifique EMAIL/PASSWORD.`,
    );
  }

  const body = JSON.parse(r.body);
  const jwt = body.access_token || body.accessToken;
  if (!jwt) fail(`Token não veio no body: ${r.body}`);
  return jwt;
}
