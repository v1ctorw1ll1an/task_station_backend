// Throttle abuse — simula um único atacante batendo /auth/login.
// Verifica que o UserAwareThrottlerGuard segura o abuso (esperado: ~5 reqs
// passam, resto vira 429).
//
// Roda: k6 run 05-throttle-abuse.js
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL } from './_helpers.js';

const status429 = new Counter('throttled_429');
const status2xx = new Counter('passed_2xx');
const status401 = new Counter('rejected_401');

export const options = {
  vus: 1,
  iterations: 50,           // 50 tentativas seguidas do mesmo "atacante"
  thresholds: {
    // Esperado: throttler bloqueia ao menos 40 das 50 (acima de 5/min)
    'throttled_429': ['count>40'],
  },
};

export default function () {
  const r = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({
      email: 'inexistente@invalido.com',
      password: 'senha-errada-para-testar',
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (r.status === 429) status429.add(1);
  else if (r.status >= 200 && r.status < 300) status2xx.add(1);
  else if (r.status === 401) status401.add(1);

  check(r, { 'esperado 401 ou 429': (x) => x.status === 401 || x.status === 429 });
}
