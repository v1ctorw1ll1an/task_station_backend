#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
# TaskDY — bateria automatizada de testes de segurança.
#
# Cobre os vetores tratados nas Fases 1–4 do hardening:
#   • Body limit (413), @MaxLength nos DTOs (400), CORS, Helmet, Swagger gating
#   • Throttler global + rotas sensíveis (login, forgot, first-access, etc.)
#   • Validação real de file upload, path traversal, JWT, endpoints públicos
#   • Cota de storage por workspace, expiração de guest token (opcional)
#
# Uso:
#   chmod +x backend/scripts/security-test.sh
#   BASE_URL=http://localhost:6969/api/v1\
#   EMAIL=admin@taskdy.com PASSWORD=Admin@123 \
#     ./backend/scripts/security-test.sh
#
# Opcionais para os testes "deep":
#   PROJECT_ID=<uuid>          # libera testes de upload/cota
#   TASK_ID=<uuid>             # libera testes de upload/cota
#   WORKSPACE_ID=<uuid>        # libera testes de cota
#   COMPANY_ID=<uuid>          # libera testes de cota
#   RUN_THROTTLE=1             # roda o teste de throttle (faz muitas reqs)
#
# Dependências: bash, curl, jq, python3 (apenas para gerar payloads gigantes).
# ────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:6969/api/v1}"
EMAIL="${EMAIL:-admin@taskdy.com}"
PASSWORD="${PASSWORD:-Admin@123456}"
RUN_THROTTLE="${RUN_THROTTLE:-0}"

# ─── cores ──────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'; BLU=$'\e[34m'; DIM=$'\e[2m'; CLR=$'\e[0m'
else
  RED= GRN= YLW= BLU= DIM= CLR=
fi

PASS=0; FAIL=0; SKIP=0
declare -a FAILURES=()

ok()   { echo "  ${GRN}✓${CLR} $1"; PASS=$((PASS+1)); }
bad()  { echo "  ${RED}✗${CLR} $1"; FAIL=$((FAIL+1)); FAILURES+=("$1"); }
skip() { echo "  ${YLW}↷${CLR} $1 ${DIM}(skipped)${CLR}"; SKIP=$((SKIP+1)); }
hdr()  { echo; echo "${BLU}━━━ $1 ━━━${CLR}"; }

# Faz uma request e devolve status code no stdout.
status() {
  curl -k -s -o /dev/null -w "%{http_code}" "$@"
}
# Faz uma request e devolve só os headers (-I), em lowercase.
headers() {
  curl -k -sI "$@" | tr -d '\r' | awk '{print tolower($0)}'
}

require() {
  for tool in "$@"; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "${RED}Faltando dependência:${CLR} $tool"
      exit 1
    fi
  done
}
require curl jq python3

echo "${BLU}Base URL:${CLR} $BASE_URL"
echo "${BLU}User:${CLR}     $EMAIL"

# ─── 0. Reachability ────────────────────────────────────────────────────────
hdr "0. Reachability"
HEALTH_STATUS=$(status "$BASE_URL/health")
if [ "$HEALTH_STATUS" = "200" ]; then
  ok "/health responde 200"
else
  bad "/health respondeu $HEALTH_STATUS — abortando (servidor não está no ar?)"
  exit 1
fi

# ─── 1. Helmet & security headers ───────────────────────────────────────────
hdr "1. Headers de segurança (Helmet)"
H=$(headers "$BASE_URL/health")

grep -q '^x-content-type-options: nosniff' <<< "$H" \
  && ok "X-Content-Type-Options: nosniff" \
  || bad "X-Content-Type-Options ausente"

grep -q '^x-frame-options:' <<< "$H" \
  && ok "X-Frame-Options presente" \
  || bad "X-Frame-Options ausente"

grep -q '^strict-transport-security:' <<< "$H" \
  && ok "Strict-Transport-Security presente" \
  || bad "Strict-Transport-Security ausente"

grep -q '^x-powered-by:' <<< "$H" \
  && bad "X-Powered-By exposto (deveria estar removido pelo helmet)" \
  || ok "X-Powered-By removido"

# ─── 2. Swagger gating ──────────────────────────────────────────────────────
hdr "2. Swagger só em dev"
SWAGGER_ROOT="${BASE_URL%/api/v1}"
SWAGGER_STATUS=$(status "$SWAGGER_ROOT/api/docs")
if [ "${NODE_ENV:-development}" = "production" ]; then
  [ "$SWAGGER_STATUS" = "404" ] \
    && ok "Swagger fechado em prod (404)" \
    || bad "Swagger exposto em prod (status $SWAGGER_STATUS)"
else
  [ "$SWAGGER_STATUS" = "200" ] \
    && ok "Swagger aberto em dev (200)" \
    || skip "Swagger respondeu $SWAGGER_STATUS em dev (esperado 200)"
fi

# ─── 3. Body limit (1 MB) ───────────────────────────────────────────────────
hdr "3. Limite de body (1 MB no Express)"
BIG=$(mktemp)
python3 -c "print('{\"email\":\"a@b.com\",\"password\":\"' + 'x'*2000000 + '\"}')" > "$BIG"
S=$(status -X POST "$BASE_URL/auth/login" -H 'Content-Type: application/json' --data-binary "@$BIG")
[ "$S" = "413" ] \
  && ok "JSON 2 MB → 413" \
  || bad "JSON 2 MB retornou $S (esperado 413)"
rm -f "$BIG"

# Form urlencoded — usa arquivo para não estourar limite de argv do shell
BIG_FORM=$(mktemp)
python3 -c "print('password=' + 'x'*2000000)" > "$BIG_FORM"
S=$(status -X POST "$BASE_URL/auth/login" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-binary "@$BIG_FORM")
[ "$S" = "413" ] \
  && ok "urlencoded 2 MB → 413" \
  || bad "urlencoded 2 MB retornou $S (esperado 413)"
rm -f "$BIG_FORM"

# ─── 4. CORS ────────────────────────────────────────────────────────────────
hdr "4. CORS"
H=$(headers -H 'Origin: https://malicious.example.com' "$BASE_URL/health")
ALLOWED=$(grep '^access-control-allow-origin:' <<< "$H" | head -1)
if [ -z "$ALLOWED" ]; then
  ok "Origem maliciosa rejeitada (sem ACAO)"
elif grep -q 'malicious.example.com' <<< "$ALLOWED"; then
  bad "CORS ecoa origem arbitrária ($ALLOWED)"
else
  ok "ACAO presente mas restrito ($ALLOWED)"
fi

# ─── 5. Login + JWT ─────────────────────────────────────────────────────────
hdr "5. Login & JWT"
LOGIN_BODY=$(jq -nc --arg email "$EMAIL" --arg pass "$PASSWORD" \
  '{email:$email, password:$pass}')
LOGIN_RES=$(curl -k -s -X POST "$BASE_URL/auth/login" \
  -H 'Content-Type: application/json' -d "$LOGIN_BODY")
JWT=$(jq -r '.access_token // .accessToken // empty' <<< "$LOGIN_RES")

if [ -n "$JWT" ]; then
  ok "Login bem-sucedido — JWT obtido"
  AUTH="Authorization: Bearer $JWT"
else
  bad "Login falhou (response: $(jq -c <<< "$LOGIN_RES" 2>/dev/null || echo "$LOGIN_RES"))"
  AUTH=""
fi

# Token inválido → 401
S=$(status -H 'Authorization: Bearer xx.yy.zz' "$BASE_URL/me/perfil")
[ "$S" = "401" ] && ok "JWT inválido → 401" || bad "JWT inválido retornou $S"

# Sem token → 401
S=$(status "$BASE_URL/me/perfil")
[ "$S" = "401" ] && ok "Sem token → 401" || bad "Sem token retornou $S"

# ─── 6. @MaxLength em DTOs ──────────────────────────────────────────────────
hdr "6. @MaxLength nos DTOs"
# IMPORTANTE: usamos endpoints SEM @UseGuards(LocalAuthGuard) — o LocalAuthGuard
# roda ANTES da ValidationPipe e retornaria 401 antes do DTO validar.
#
# /auth/forgot-password tem throttle de 3 req/hora (anti-enumeração). Se ele
# estourar, 429 não significa falha de validação — marcamos como "skip" porque
# a validação só roda depois do guard de throttle.

# /auth/forgot-password só tem @IsEmail + @MaxLength(254), sem guard.
# Email > 254 → 400
EMAIL_HUGE="$(python3 -c 'print("a"*260)')@b.com"
S=$(status -X POST "$BASE_URL/auth/forgot-password" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL_HUGE\"}")
case "$S" in
  400) ok "Email > 254 chars → 400" ;;
  429) skip "Email > 254 (throttle /forgot-password esgotado — aguarde 1h)" ;;
  *)   bad "Email > 254 retornou $S" ;;
esac

# Email inválido → 400
S=$(status -X POST "$BASE_URL/auth/forgot-password" \
  -H 'Content-Type: application/json' \
  -d '{"email":"not-an-email"}')
case "$S" in
  400) ok "Email inválido → 400" ;;
  429) skip "Email inválido (throttle esgotado)" ;;
  *)   bad "Email inválido retornou $S" ;;
esac

# Campo desconhecido (whitelist do ValidationPipe) → 400
S=$(status -X POST "$BASE_URL/auth/forgot-password" \
  -H 'Content-Type: application/json' \
  -d '{"email":"x@y.com","admin":true}')
case "$S" in
  400) ok "Campo extra no body → 400 (forbidNonWhitelisted)" ;;
  429) skip "Campo extra (throttle esgotado)" ;;
  *)   bad "Campo extra retornou $S" ;;
esac

# /auth/first-access valida senha (@MinLength(8) @MaxLength(72)) antes de
# checar o token — passa pela ValidationPipe sem LocalAuthGuard no caminho.
PWD_HUGE=$(python3 -c 'print("x"*500)')
S=$(status -X POST "$BASE_URL/auth/first-access?token=invalid" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"abc\",\"newPassword\":\"$PWD_HUGE\",\"confirmPassword\":\"$PWD_HUGE\"}")
[ "$S" = "400" ] \
  && ok "Senha 500 chars → 400 (rejeitada pelo DTO)" \
  || bad "Senha 500 chars retornou $S (esperado 400)"

# Senha curta (< 8) → 400
S=$(status -X POST "$BASE_URL/auth/first-access?token=invalid" \
  -H 'Content-Type: application/json' \
  -d '{"name":"abc","newPassword":"abc","confirmPassword":"abc"}')
[ "$S" = "400" ] \
  && ok "Senha < 8 chars → 400" \
  || bad "Senha curta retornou $S"

# ─── 7. Path traversal & injeção em params de URL ───────────────────────────
hdr "7. Path traversal / injeção em parâmetros"

# UUID inválido em rota que espera UUID → 400 (ParseUUIDPipe / @IsUUID)
S=$(status -H "$AUTH" "$BASE_URL/projetos/..%2F..%2Fetc%2Fpasswd/tasks")
case "$S" in
  400|401|404) ok "Path traversal em :projectId rejeitado ($S)" ;;
  *) bad "Path traversal em :projectId retornou $S (esperado 400/404)" ;;
esac

# SQL injection clássico em campo de busca — Prisma usa parameterized queries,
# então deve apenas ser tratado como string sem efeito colateral.
if [ -n "$AUTH" ]; then
  S=$(status -H "$AUTH" "$BASE_URL/superadmin/usuarios?search=%27%20OR%201%3D1--")
  case "$S" in
    200|403) ok "SQL injection em search tratada como string ($S)" ;;
    500) bad "Search com aspas retornou 500 — pode indicar query não parametrizada" ;;
    *) skip "Search retornou $S (não conclusivo)" ;;
  esac
else
  skip "Sem JWT — pulando teste de SQL injection autenticado"
fi

# ─── 8. Throttler ──────────────────────────────────────────────────────────
hdr "8. Throttler (rate limit)"
if [ "$RUN_THROTTLE" != "1" ]; then
  skip "Throttle (RUN_THROTTLE=1 para rodar — gasta budget do servidor)"
else
  # Login: 5 reqs/min — a 6ª deve dar 429
  for i in 1 2 3 4 5; do
    status -X POST "$BASE_URL/auth/login" \
      -H 'Content-Type: application/json' \
      -d '{"email":"throttle@test.com","password":"wrong-but-valid-len"}' >/dev/null
  done
  S=$(status -X POST "$BASE_URL/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"throttle@test.com","password":"wrong-but-valid-len"}')
  [ "$S" = "429" ] \
    && ok "Login: 6ª req em <1min → 429" \
    || bad "Login throttle não barrou (status $S)"

  # First-access: 10 reqs/min — a 11ª deve dar 429
  for i in $(seq 1 10); do
    status -X POST "$BASE_URL/auth/first-access?token=invalid" \
      -H 'Content-Type: application/json' \
      -d '{"name":"abc","newPassword":"12345678","confirmPassword":"12345678"}' >/dev/null
  done
  S=$(status -X POST "$BASE_URL/auth/first-access?token=invalid" \
    -H 'Content-Type: application/json' \
    -d '{"name":"abc","newPassword":"12345678","confirmPassword":"12345678"}')
  [ "$S" = "429" ] \
    && ok "first-access: 11ª req em <1min → 429" \
    || bad "first-access throttle não barrou (status $S)"

  echo "  ${DIM}aguardando 65s para o budget resetar antes dos próximos testes...${CLR}"
  sleep 65
fi

# ─── 9. Endpoints públicos / autorização ────────────────────────────────────
hdr "9. Endpoints sensíveis exigem JWT"
NIL_UUID="00000000-0000-0000-0000-000000000000"
# Lista rotas reais que existem (não as raízes 404). O ponto é provar que
# nenhuma rota autenticada vaza recurso sem token.
for path in /me/perfil /superadmin/usuarios "/empresa/$NIL_UUID/membros" /me/notificacoes; do
  S=$(status "$BASE_URL$path")
  [ "$S" = "401" ] \
    && ok "$path sem token → 401" \
    || bad "$path sem token retornou $S"
done

# Endpoints públicos esperados
# /health é GET-only
S=$(status "$BASE_URL/health")
[ "$S" = "200" ] && ok "/health (GET) → 200" || bad "/health retornou $S"

# /auth/forgot-password aceita POST sem auth
S=$(status -X POST "$BASE_URL/auth/forgot-password" \
  -H 'Content-Type: application/json' -d '{"email":"x@y.com"}')
case "$S" in
  200|400|429) ok "/auth/forgot-password acessível sem auth ($S)" ;;
  401) bad "/auth/forgot-password exigiu auth — deveria ser @Public" ;;
  *) skip "/auth/forgot-password retornou $S" ;;
esac

# ─── 10. Upload — magic bytes ───────────────────────────────────────────────
hdr "10. Upload — validação de tipo real"
if [ -z "$AUTH" ] || [ -z "${PROJECT_ID:-}" ] || [ -z "${TASK_ID:-}" ]; then
  skip "Upload (precisa de PROJECT_ID e TASK_ID)"
else
  FAKE=$(mktemp --suffix=.jpg)
  printf 'MZ\x90\x00' > "$FAKE"   # cabeçalho de PE/.exe disfarçado de jpg
  echo "fake binary content" >> "$FAKE"
  S=$(status -X POST "$BASE_URL/projetos/$PROJECT_ID/tasks/$TASK_ID/attachments" \
    -H "$AUTH" -F "file=@$FAKE;type=image/jpeg")
  case "$S" in
    400|415|422) ok ".exe disfarçado de .jpg rejeitado ($S)" ;;
    *) bad ".exe disfarçado de .jpg passou (status $S) — Sharp deveria rejeitar" ;;
  esac
  rm -f "$FAKE"

  # Arquivo > 16 MB de imagem → 413 do Multer
  BIG_FAKE=$(mktemp --suffix=.png)
  dd if=/dev/urandom of="$BIG_FAKE" bs=1M count=20 status=none
  S=$(status -X POST "$BASE_URL/projetos/$PROJECT_ID/tasks/$TASK_ID/attachments" \
    -H "$AUTH" -F "file=@$BIG_FAKE;type=image/png")
  case "$S" in
    413|400) ok "Imagem 20 MB → $S (limite Multer)" ;;
    *) bad "Imagem 20 MB retornou $S (esperado 413)" ;;
  esac
  rm -f "$BIG_FAKE"
fi

# ─── 11. Cota de storage do workspace ───────────────────────────────────────
hdr "11. Cota de storage do workspace"
if [ -z "$AUTH" ] || [ -z "${COMPANY_ID:-}" ] || [ -z "${WORKSPACE_ID:-}" ] \
   || [ -z "${PROJECT_ID:-}" ] || [ -z "${TASK_ID:-}" ]; then
  skip "Cota (precisa de COMPANY_ID, WORKSPACE_ID, PROJECT_ID, TASK_ID)"
else
  ENDPOINT="$BASE_URL/empresa/$COMPANY_ID/workspaces/$WORKSPACE_ID/storage-quota"

  # Reduz para 1 MB
  curl -k -s -X PATCH "$ENDPOINT" -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"storageQuotaBytes": 1048576}' >/dev/null

  # Sobe ~2 MB → deve dar 413
  TMP=$(mktemp --suffix=.png)
  dd if=/dev/urandom of="$TMP" bs=1M count=2 status=none
  S=$(status -X POST "$BASE_URL/projetos/$PROJECT_ID/tasks/$TASK_ID/attachments" \
    -H "$AUTH" -F "file=@$TMP;type=image/png")
  rm -f "$TMP"

  [ "$S" = "413" ] \
    && ok "Upload acima da cota → 413" \
    || bad "Upload acima da cota retornou $S (esperado 413)"

  # Devolve cota a 10 GiB
  curl -k -s -X PATCH "$ENDPOINT" -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"storageQuotaBytes": 10737418240}' >/dev/null
fi

# ─── 13. Volume caps — anti-abuso ───────────────────────────────────────────
hdr "13. Volume caps (mentions, guests, reorder, history pagination)"

if [ -z "$AUTH" ] || [ -z "${PROJECT_ID:-}" ] || [ -z "${TASK_ID:-}" ]; then
  skip "Volume caps (precisa de PROJECT_ID e TASK_ID)"
else
  # 13.1 Reorder com array gigante → 400 (ArrayMaxSize)
  # Gera 600 UUIDs falsos
  REORDER_BODY=$(python3 -c '
import json, uuid
ids = [str(uuid.uuid4()) for _ in range(600)]
print(json.dumps({"columnIds": ids}))')
  S=$(status -X PATCH "$BASE_URL/projetos/$PROJECT_ID/colunas/reorder" \
    -H "$AUTH" -H 'Content-Type: application/json' \
    -d "$REORDER_BODY")
  case "$S" in
    400|403) ok "Reorder com 600 IDs → $S (rejeitado)" ;;
    *) bad "Reorder com 600 IDs retornou $S (esperado 400)" ;;
  esac

  # 13.2 Task history retorna paginado (shape { data, total, page, limit })
  RESP=$(curl -k -s -H "$AUTH" "$BASE_URL/projetos/$PROJECT_ID/tasks/$TASK_ID/history")
  HAS_DATA=$(jq -r 'has("data") and has("total") and has("page") and has("limit")' <<< "$RESP" 2>/dev/null || echo "false")
  LIMIT=$(jq -r '.limit // "missing"' <<< "$RESP" 2>/dev/null)
  if [ "$HAS_DATA" = "true" ] && [ "$LIMIT" = "20" ]; then
    ok "Task history paginado (default limit=20)"
  else
    bad "Task history sem paginação ou shape inesperado (limit=$LIMIT)"
  fi

  # 13.3 Task history rejeita limit > 100
  S=$(status -H "$AUTH" "$BASE_URL/projetos/$PROJECT_ID/tasks/$TASK_ID/history?limit=500")
  [ "$S" = "400" ] \
    && ok "Task history limit=500 → 400 (cap em 100)" \
    || bad "Task history limit=500 retornou $S (esperado 400)"

  # 13.4 Guests/task — testar cap requer state setup (criar até 20). Skip
  # automático aqui e deixar como teste manual.
  skip "Guests/task cap (testar manualmente: criar 21 guests na mesma task → 21º = 400)"

  # 13.5 Mentions cap — não dá pra verificar via curl sozinho (precisa
  # inspeção em notifications). Skip com nota.
  skip "Mentions cap (validar via psql: SELECT COUNT(*) FROM notifications WHERE ...)"
fi

# ─── 12. Headers do frontend ────────────────────────────────────────────────
hdr "12. Frontend headers (se rodando)"
FRONT_URL="${FRONT_URL:-http://localhost:3000}"
if curl -k -s -o /dev/null -w '%{http_code}' "$FRONT_URL" | grep -q '^[23]'; then
  H=$(headers "$FRONT_URL")
  grep -q '^x-frame-options:' <<< "$H" \
    && ok "frontend X-Frame-Options presente" \
    || bad "frontend X-Frame-Options ausente"
  grep -q '^x-content-type-options:' <<< "$H" \
    && ok "frontend X-Content-Type-Options presente" \
    || bad "frontend X-Content-Type-Options ausente"
  grep -q '^x-powered-by:' <<< "$H" \
    && bad "frontend ainda envia X-Powered-By" \
    || ok "frontend sem X-Powered-By"
else
  skip "Frontend não respondendo em $FRONT_URL"
fi

# ─── Resumo ─────────────────────────────────────────────────────────────────
echo
echo "${BLU}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CLR}"
echo "${GRN}Passou:${CLR}    $PASS"
echo "${RED}Falhou:${CLR}    $FAIL"
echo "${YLW}Pulado:${CLR}    $SKIP"
echo "${BLU}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CLR}"

if [ "$FAIL" -gt 0 ]; then
  echo
  echo "${RED}Falhas:${CLR}"
  for f in "${FAILURES[@]}"; do
    echo "  • $f"
  done
  echo
  echo "${YLW}Lembrete:${CLR} XSS no markdown e CSP completo precisam ser"
  echo "verificados no browser — abra DevTools, cole \`![x](javascript:alert(1))\`"
  echo "em um comentário e confirme que nenhum alert dispara."
  exit 1
fi

echo
echo "${GRN}Todos os testes automatizáveis passaram.${CLR}"
echo "${DIM}Ainda assim, valide manualmente:${CLR}"
echo "  • XSS no markdown (browser + DevTools)"
echo "  • Guest token TTL (precisa criar guest e esperar expirar)"
echo "  • Job de expurgo (rodar SoftDeletePurgeService.run() manualmente)"
