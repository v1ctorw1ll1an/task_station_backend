// Stress test — passa do limite esperado pra achar o ponto de quebra.
// Sobe até 500 VUs e mantém. Em algum ponto o p95 vai disparar ou começarão 5xx.
// Anote o número de VUs onde isso acontece — é a capacidade real do servidor.
//
// Roda: k6 run 03-stress.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, login } from './_helpers.js';

export const options = {
  stages: [
    { duration: '1m', target: 100 },
    { duration: '2m', target: 200 },
    { duration: '2m', target: 300 },
    { duration: '2m', target: 500 },
    { duration: '3m', target: 500 },
    { duration: '1m', target: 0 },
  ],
  // Sem thresholds bloqueantes — queremos VER onde quebra, não falhar cedo.
  thresholds: {
    http_req_failed: ['rate<0.50'],   // alerta acima de 50% de erro
  },
};

export function setup() {
  return { jwt: login() };
}

export default function (data) {
  const headers = { Authorization: `Bearer ${data.jwt}` };

  const r = http.get(`${BASE_URL}/me/perfil`, { headers });
  check(r, {
    '2xx': (x) => x.status >= 200 && x.status < 300,
    'não-5xx': (x) => x.status < 500,
    'não-429 (throttle não bateu)': (x) => x.status !== 429,
  });

  sleep(0.2);
}
