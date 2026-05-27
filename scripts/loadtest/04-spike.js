// Spike test — pico súbito (10 → 1000 VUs em 30s).
// Objetivo: ver se o autoscaling/worker pool/conexões DB aguentam um burst,
// e se o sistema se RECUPERA depois (volta a p95 normal quando a onda passa).
//
// Roda: k6 run 04-spike.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, login } from './_helpers.js';

export const options = {
  stages: [
    { duration: '30s', target: 10 },    // baseline calmo
    { duration: '30s', target: 1000 },  // SPIKE
    { duration: '1m', target: 1000 },   // sustenta o pico
    { duration: '30s', target: 10 },    // volta ao normal
    { duration: '1m', target: 10 },     // confirma recuperação
  ],
  thresholds: {
    http_req_failed: ['rate<0.40'],
  },
};

export function setup() {
  return { jwt: login() };
}

export default function (data) {
  const headers = { Authorization: `Bearer ${data.jwt}` };
  const r = http.get(`${BASE_URL}/me/perfil`, { headers });
  check(r, { '2xx': (x) => x.status >= 200 && x.status < 300 });
  sleep(0.3);
}
