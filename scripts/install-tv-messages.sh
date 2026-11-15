#!/usr/bin/env bash
# Execute na raiz do backend. Não substitui arquivos existentes do app.
set -euo pipefail
cd "$(dirname "$0")/.."
for f in src/app.js src/modules/tv-messages/panel.routes.js src/modules/tv-messages/device.routes.js src/modules/tv-messages/message.service.js src/modules/tv-messages/message.policy.js src/db/migrations/20261217000001-tv-messages.cjs; do
  [[ -f "$f" ]] || { echo "ERRO: arquivo ausente: $f" >&2; exit 1; }
done
for f in src/modules/tv-messages/*.js; do node --check "$f"; done
node --check src/app.js
python3 - <<'PY'
from pathlib import Path
from datetime import datetime, timezone
p=Path('src/app.js')
s=p.read_text()
if 'export function createApp()' not in s or 'app.use(apiLimiter)' not in s or 'app.use("/api/v1/auth", authRoutes)' not in s:
  raise SystemExit('ERRO: src/app.js diferente do esperado. Nenhum arquivo foi modificado; analise manual necessária.')
imp='''import tvMessagePanelRoutes from "./modules/tv-messages/panel.routes.js";
import tvMessageDeviceRoutes from "./modules/tv-messages/device.routes.js";
'''
if 'tvMessagePanelRoutes from ' not in s and 'tvMessageDeviceRoutes from ' not in s:
  s=imp+s
elif 'tvMessagePanelRoutes from ' not in s or 'tvMessageDeviceRoutes from ' not in s:
  raise SystemExit('ERRO: integração parcial detectada. Examine app.js antes de continuar.')
if 'app.use("/api/v1/client/tv-messages"' not in s:
  s=s.replace('  app.use(apiLimiter);', '''  // Mensagens na TV: autenticação por token e limite individual, fora do limite por IP compartilhado.
  app.use("/api/v1/client/tv-messages", tvMessageDeviceRoutes);
  app.use(apiLimiter);''',1)
if 'app.use("/api/v1/tv-messages"' not in s:
  s=s.replace('  app.use("/api/v1/auth", authRoutes);', '''  // API do painel para comunicados persistentes.
  app.use("/api/v1/tv-messages", tvMessagePanelRoutes);
  app.use("/api/v1/auth", authRoutes);''',1)
if s==p.read_text():
  print('src/app.js já possui ambas as rotas: nenhuma alteração necessária.')
else:
  backup=p.with_name('app.js.before-tv-messages-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
  backup.write_text(p.read_text())
  p.write_text(s)
  print(f'Backup criado: {backup}')
  print('Rotas de mensagens integradas ao src/app.js.')
PY
node --check src/app.js
node --check src/modules/tv-messages/panel.routes.js
node --check src/modules/tv-messages/device.routes.js
printf '\nArquivos prontos. Próximas etapas: npm run db:migrate; testar o backend; reiniciar o processo do PM2.\n'
