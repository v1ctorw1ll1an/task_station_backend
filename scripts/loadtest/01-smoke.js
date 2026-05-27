// Smoke test — 1 usuário, 1 minuto. Sanity check antes de qualquer carga real.
// Roda: k6 run 01-smoke.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, login } from './_helpers.js';

export const options = {
  vus: 1,
  duration: '1m',
  thresholds: {
    http_req_failed: ['rate<0.01'],          // < 1% de erros
    http_req_duration: ['p(95)<500'],        // p95 < 500ms
  },
};

export function setup() {
  return { jwt: login() };
}

export default function (data) {
  const headers = { Authorization: `Bearer ${data.jwt}` };

  const r1 = http.get(`${BASE_URL}/health`);
  check(r1, { 'health 200': (r) => r.status === 200 });

  const r2 = http.get(`${BASE_URL}/me/perfil`, { headers });
  check(r2, { 'me/perfil 200': (r) => r.status === 200 });

  sleep(1);
}
