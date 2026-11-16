#!/usr/bin/env bash
# Verificação completa contra um PostgreSQL DE TESTE: migrations (subir, desfazer as novas, subir de novo) + todos os testes.
# Uso:  DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/iptv_licensing_test npm run verify:db
# ATENÇÃO: o banco informado é DESTRUÍDO e recriado. Por segurança o script recusa:
#   - banco cujo nome não contenha "test";
#   - host que não seja localhost/127.0.0.1 (a menos que você exporte ALLOW_REMOTE_TEST_DB=yes conscientemente).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL_TEST:?Defina DATABASE_URL_TEST apontando para um banco de TESTE (ex.: .../iptv_licensing_test)}"

url="$DATABASE_URL_TEST"
dbname="${url##*/}"; dbname="${dbname%%\?*}"
hostpart="${url#*@}"; hostpart="${hostpart%%/*}"; host="${hostpart%%:*}"

if [[ "$dbname" != *test* ]]; then
  echo "RECUSADO: o nome do banco ('$dbname') não contém 'test'. Este script apaga o banco." >&2; exit 2
fi
if [[ "$host" != "localhost" && "$host" != "127.0.0.1" && "${ALLOW_REMOTE_TEST_DB:-}" != "yes" ]]; then
  echo "RECUSADO: host remoto ('$host'). Use um PostgreSQL local de teste, ou exporte ALLOW_REMOTE_TEST_DB=yes se tiver certeza de que é descartável." >&2; exit 2
fi

export DATABASE_URL="$url" NODE_ENV=test
NEW_MIGRATIONS=8   # 20261018000001..04 + 20261021000001 + 20261025000001 + 20261026000001 + 20261027000001

step() { printf '\n=== %s ===\n' "$*"; }

step "1/5 recriar do zero e subir todas as migrations"
npx sequelize-cli db:migrate:undo:all >/dev/null 2>&1 || true
npx sequelize-cli db:migrate

step "2/5 desfazer as $NEW_MIGRATIONS migrations novas (down) uma a uma"
for _ in $(seq 1 "$NEW_MIGRATIONS"); do npx sequelize-cli db:migrate:undo; done

step "3/5 subir de novo (up depois de down)"
npx sequelize-cli db:migrate

step "4/5 testes unitários"
npm run test:unit

step "5/5 testes de integração (recriam o banco de teste)"
DATABASE_URL_TEST="$url" npm test

echo; echo "VERIFICAÇÃO CONCLUÍDA SEM ERROS."
