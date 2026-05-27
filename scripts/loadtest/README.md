# Loadtest do TaskDY

Bateria progressiva de teste de carga com [k6](https://k6.io). Este **não é um
ataque DDoS** — é um stress test em ambiente que você controla (HML), para
descobrir a capacidade real do servidor e o ponto de quebra.

---

## TL;DR — fluxo recomendado

```bash
# 1. instala o k6
sudo pacman -S k6                # Arch
# brew install k6                # Mac
# https://k6.io/docs/get-started/installation/ para outros

# 2. roda em ordem crescente — sempre comece pelo smoke
cd backend/scripts/loadtest
BASE_URL=http://hml.taskdy.com/api/v1 ./run-all.sh smoke
./run-all.sh load
./run-all.sh stress
./run-all.sh spike
./run-all.sh throttle-abuse

# ou tudo de uma vez (cuidado — ~30 minutos):
./run-all.sh all
```

---

## Setup (5 minutos antes do primeiro run)

### 1. Instale o k6 na máquina que vai gerar a carga

```bash
sudo pacman -S k6                          # Arch
brew install k6                            # Mac
# Outros: https://k6.io/docs/get-started/installation/
```

### 2. Prepare o alvo (HML)

- Apontar **somente para HML**, nunca produção real.
- Sem CDN/WAF no caminho, ou faça whitelist do IP do gerador — senão você mede
  o WAF e não a aplicação.
- Banco com dados de seed: `cd backend && pnpm seed`.
- Garanta que o admin existe e tem membership nos recursos de teste (use
  `scripts/grant-test-access.ts`).

### 3. Rode de uma máquina **diferente** do servidor

Loopback (`localhost → localhost`) esconde gargalos de rede e o gerador de
carga compete CPU com o app, distorcendo os números. Use:
- um notebook na mesma rede do servidor HML, ou
- uma VM separada, ou
- um runner de CI.

### 4. Abra 4 painéis em paralelo, no servidor HML

| Painel | Comando | O que observar |
|--------|---------|---------------|
| 1 | `htop` (ou `btop`) | CPU e RAM do processo `node` e do `postgres` |
| 2 | `iostat -xm 2` | IO do disco (vital quando há upload de anexos) |
| 3 | `watch -n 2 'psql -d taskdy -c "SELECT count(*) FROM pg_stat_activity WHERE state='\''active'\'';"'` | Conexões ativas no Postgres |
| 4 | `tail -f` no log do backend | Erros 5xx, timeouts, mensagens do throttler |

Se tiver Grafana + dashboards do node/postgres, melhor ainda — substitui os 4.

---

## Os scripts

| # | Arquivo | O que faz | Duração |
|---|---------|-----------|---------|
| 0 | `_helpers.js` | Login compartilhado (importado pelos outros) | — |
| 1 | `01-smoke.js` | 1 VU, 1 min — sanity check | 1 min |
| 2 | `02-load.js` | Sobe a 50 VUs e sustenta 5 min | 8 min |
| 3 | `03-stress.js` | Sobe até 500 VUs procurando o breakpoint | 11 min |
| 4 | `04-spike.js` | Pico de 10 → 1000 VUs em 30 s | 3:30 min |
| 5 | `05-throttle-abuse.js` | 50 reqs no /login do mesmo IP | ~30 s |

---

## Execução progressiva — o que esperar em cada fase

### Smoke (1 min)
SLO: p95 < 500ms, < 1% erro.
**Se falhar, pare** — algo está fundamentalmente errado, não adianta carregar.

### Load (8 min)
SLO: p95 < 800ms para reads, < 2% erro, throughput sustentado.
**Significado:** a app aguenta o uso normal (50 usuários ativos com 0.5–2.5 s
de think time entre ações).

### Stress (11 min)
**Esse é o teste que importa.** Anote em qual número de VUs aconteceu:

| Sinal | O que indica |
|-------|--------------|
| p95 passa de 1 s | Início da degradação — você achou o "joelho" da curva |
| Aparecem 5xx | Saturação real — saiu do regime saudável |
| CPU do `node` > 80% | Gargalo no app (provavelmente Sharp/FFmpeg) |
| CPU do `postgres` > 80% | Gargalo de banco — falta índice ou conexões insuficientes |
| `pg_stat_activity` com muitos `waiting` | Lock contention no banco |
| IO disk saturado | Anexos lentos (PDFs/vídeos sendo escritos) |

**Capacidade real:** o número de VUs onde o p95 passa de 1 s. Multiplique pelas
suas premissas:
> Exemplo: se 1 usuário ativo faz ~5 req/min e o sistema quebra em 300 VUs
> sustentando 50 req/s → capacidade ≈ 600 usuários ativos simultâneos.

### Spike (3:30 min)
Erros **vão subir** durante o pico (esperado). O critério não é "0 erros" — é:

✅ **p95 volta ao normal em ≤ 30 s após o pico acabar.**

Se p95 fica alto por muito tempo após o spike, há:
- connection leak no DB,
- worker pool do Piscina entupido,
- ou GC do Node travando.

### Throttle abuse (~30 s)
Esperado no output do k6:
```
throttled_429....: 45     ← UserAwareThrottlerGuard segurou
rejected_401.....: 5      ← passaram só os primeiros 5 (limite 5/min)
passed_2xx.......: 0      ← se > 0, alguma credencial vazou
```

Se `throttled_429 < 40`, a janela do throttler está errada ou foi
desabilitada por engano.

---

## Sem o orquestrador (uso direto do k6)

```bash
k6 run -e BASE_URL=https://hml.taskdy.com/api/v1 01-smoke.js

# Com mais variáveis:
k6 run \
  -e BASE_URL=https://hml.taskdy.com/api/v1 \
  -e EMAIL=outro@admin.com \
  -e PASSWORD=senha-do-outro \
  03-stress.js
```

Cada script tem `export const options` com stages/thresholds. Se um threshold
falhar, k6 sai com `exit 1` — útil em CI gating.

---

## Como interpretar o output do k6

Ao final de cada run k6 imprime algo como:

```
http_req_duration..............: avg=120ms  p(95)=400ms  p(99)=800ms
http_req_failed................: 0.50% ✓ 12  ✗ 2400
iterations.....................: 2412   80.4/s
vus_max........................: 50
```

| Métrica | O que significa | Quando preocupar |
|---------|-----------------|------------------|
| `http_req_duration p(95)` | 95% das reqs respondem em < X | > 1 s sob carga normal |
| `http_req_duration p(99)` | cauda longa | > 3 s consistente |
| `http_req_failed` | % de reqs com status ≥ 400 | > 5% sob carga normal |
| `iterations` (req/s) | throughput sustentado | Se cai sob carga, achou o teto |
| `vus_max` | VUs simultâneas no pico | Use pra capacity planning |

---

## Cuidados

- **HML, nunca produção pública.** Mesmo sendo "seu", produção tem usuários
  reais que vão ver degradação.
- **Sem CDN/WAF no caminho** ou IP whitelisted.
- **Sem outros testes simultâneos** — outras pessoas no HML vão ter sessão
  derrubada.
- **Banco com dados de seed apenas.** Stress sobre dados sensíveis ou de
  produção é uma péssima ideia.
- **Aviso ao datacenter/cloud.** AWS, GCP, Hetzner, DigitalOcean podem
  detectar como atividade suspeita e suspender — alguns exigem aviso prévio
  para load test acima de X req/s. Verifique o AUP do seu provedor.

---

## O que este setup **não** testa

| Cenário | Por que não dá aqui | Solução correta |
|---------|---------------------|-----------------|
| DDoS volumétrico (botnet 1000s IPs) | Uma máquina k6 não simula IPs distintos | **AWS Shield Test**, **NimbusDDoS**, **Activereach** — sempre com autorização escrita |
| Layer 3/4 (SYN flood, UDP flood) | k6 é HTTP-only, e clouds proíbem | Teste autorizado do provedor (AWS Fault Injection, Azure DDoS Sim) |
| Slow loris (conexões parciais) | k6 não mantém conexões half-open | `slowhttptest` / `slowloris.py` em sandbox |
| Bots automatizados (scrapers) | Padrão diferente de tráfego | WAF com bot management (Cloudflare Turnstile, hCaptcha) |

Para esses, a proteção mora **a montante**: Cloudflare/AWS Shield/Akamai com
DDoS protection + WAF + bot management. A aplicação faz a parte dela
(throttle por usuário, body limit, validação, exception handling).

---

## Limpeza após os runs

```bash
# Resetar contadores de throttle (se você tem Redis/cache separado, limpe)
# No nosso caso o throttler é em memória — basta restart do backend:
cd backend && pnpm run start:dev   # interromper e subir de novo

# Conferir que não ficou anexo órfão em disco depois dos uploads de teste
ls -lh backend/uploads/attachments/ | head
# O AttachmentJanitorService limpa automaticamente em 30 dias, mas você pode
# rodar manualmente — ver docs/relatorio-seguranca.md §3.10
```

---

## Referências

- Documentação k6: https://k6.io/docs/
- Thresholds e checks: https://k6.io/docs/using-k6/thresholds/
- Stages e VU calculation: https://k6.io/docs/using-k6/scenarios/
- Relatório de segurança do TaskDY: `docs/relatorio-seguranca.md`
- Bateria de testes de segurança (curl): `backend/scripts/security-test.sh`
