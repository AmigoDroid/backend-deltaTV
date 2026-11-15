#!/usr/bin/env bash
# Garante que a falha anterior de tv-messages não seja executada por engano.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f src/db/migrations/20261218000001-code-provider-operational-deletion.cjs ]]; then
  echo 'ERRO: migração de exclusão não foi instalada.' >&2; exit 1
fi
status="$(npm run db:migrate:status 2>&1)" || { echo "$status"; exit 1; }
echo "$status" | grep -E '^(up|down) 202612(12|17|18)' || true
if echo "$status" | grep -Eq '^down 20261217000001-tv-messages'; then
  echo 'BLOQUEADO: a migração conflitante 20261217000001-tv-messages ainda está pendente. Execute o reparo anterior antes de continuar.' >&2
  exit 2
fi
if ! echo "$status" | grep -Eq '^up 20261212000001-tv-messages'; then
  echo 'BLOQUEADO: a migração original de mensagens para TVs não está registrada como aplicada.' >&2
  exit 3
fi
pending="$(echo "$status" | awk '$1 == "down" && $2 != "20261218000001-code-provider-operational-deletion.cjs" {print $2}')"
if [[ -n "$pending" ]]; then
  echo 'BLOQUEADO: há outras migrações pendentes. Revise antes de alterar a produção:' >&2
  echo "$pending" >&2
  exit 4
fi
echo 'Pré-verificação aprovada: apenas a migração operacional de exclusão pode ficar pendente.'
