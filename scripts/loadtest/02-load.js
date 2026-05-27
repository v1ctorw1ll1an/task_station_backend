// Load test — sobe gradualmente até a carga esperada normal e sustenta.
// Objetivo: verificar que o sistema aguenta o "uso normal" sem degradar.
//
// Estágios:
//   0  → 50 VUs em 2 min  (warm-up)
//   50 → 50 VUs por 5 min  (carga normal sustentada)
//   50 → 0 VUs em 1 min   (ramp-down)
//
// Roda: k6 run 02-load.js
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { BASE_URL, login } from './_helpers.js';

export const options = {
  stages: [
    { duration: '2m', target: 50 },
    { duration: '5m', target: 50 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.02'],          // < 2% de erros
    'http_req_duration{kind:read}': ['p(95)<800'],
    'http_req_duration{kind:write}': ['p(95)<1500'],
  },
};

export function setup() {
  return { jwt: login() };
}

export default function (data) {
  const headers = { Authorization: `Bearer ${data.jwt}` };

  group('reads', () => {
    const r = http.get(`${BASE_URL}/me/perfil`, {
      headers,
      tags: { kind: 'read' },
    });
    check(r, { 'me/perfil 2xx': (x) => x.status >= 200 && x.status < 300 });
  });

  group('reads — listagens', () => {
    const r = http.get(`${BASE_URL}/me/notificacoes?page=1&limit=20`, {
      headers,
      tags: { kind: 'read' },
    });
    check(r, { 'notificacoes 2xx': (x) => x.status === 200 });
  });

  sleep(Math.random() * 2 + 0.5); // think time 0.5–2.5s
}
