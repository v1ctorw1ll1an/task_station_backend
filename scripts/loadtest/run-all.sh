#!/usr/bin/env bash
# Orquestra a bateria de loadtest em sequência.
#
# Pré-requisitos:
#   sudo pacman -S k6   (Arch) | brew install k6 (mac) | apt: ver https://k6.io/docs/get-started/installation/
#
# Uso:
#   chmod +x run-all.sh
#   ./run-all.sh                          # roda tudo na ordem
#   ./run-all.sh smoke                    # roda só o smoke
#   BASE_URL=https://hml.taskdy.com ./run-all.sh
#
# Importante:
#   • Rode de uma MÁQUINA DIFERENTE do servidor — localhost esconde gargalos de rede.
#   • Tenha htop, iostat e monitor de DB abertos durante o stress/spike.
#   • Após o stress test, valide que a app voltou ao normal antes do próximo.
set -euo pipefail

cd "$(dirname "$0")"

BASE_URL="${BASE_URL:-http://localhost:6969/api/v1}"
echo "Target: $BASE_URL"
echo

if ! command -v k6 >/dev/null 2>&1; then
  echo "ERRO: k6 não instalado. Instale com:"
  echo "  Arch:   sudo pacman -S k6"
  echo "  Mac:    brew install k6"
  echo "  Docker: docker run --rm -i grafana/k6 run - < script.js"
  exit 1
fi

ALL=(smoke load stress spike throttle-abuse)
PICK="${1:-all}"

run() {
  local name=$1
  local file=$2
  echo
  echo "━━━ ▶ $name ━━━"
  k6 run -e BASE_URL="$BASE_URL" \
         -e EMAIL="${EMAIL:-admin@taskdy.com}" \
         -e PASSWORD="${PASSWORD:-Admin@123456}" \
         "$file"
  echo "━━━ ◀ $name FIM — aguardando 30s para o sistema esfriar ━━━"
  sleep 30
}

case "$PICK" in
  smoke)         run smoke 01-smoke.js ;;
  load)          run load 02-load.js ;;
  stress)        run stress 03-stress.js ;;
  spike)         run spike 04-spike.js ;;
  throttle-abuse|throttle) run throttle-abuse 05-throttle-abuse.js ;;
  all)
    run smoke 01-smoke.js
    run load 02-load.js
    run stress 03-stress.js
    run spike 04-spike.js
    run throttle-abuse 05-throttle-abuse.js
    ;;
  *)
    echo "Opções: smoke | load | stress | spike | throttle-abuse | all"
    exit 1
    ;;
esac

echo
echo "✓ Bateria concluída."
