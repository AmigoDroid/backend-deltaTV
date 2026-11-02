# Delta TV — Monitor de VPS (Superadmin)

## O que foi adicionado

- `GET /api/v1/admin/system/metrics`: requer token de administrador **com papel superadmin** (`system:metrics`).
- WebSocket existente `/ws`: após autenticação, somente superadmin pode enviar `{"type":"system-metrics-subscribe","enabled":true}` e receber eventos `system-metrics` a cada 5 segundos.
- `enabled:false` interrompe o envio para aquela aba. Nenhuma amostra contínua é coletada quando não há assinantes.
- Leitura local via APIs Node.js / Linux: CPU, MemAvailable, swap, disco raiz, tempo ligado da VPS, memória RSS/heap e tempo ativo do backend Node.

## Segurança e desempenho

- Sem `exec`, `spawn`, `sudo`, agentes externos, banco, novas dependências ou migrações.
- Métricas nunca são encaminhadas para revendas, admins ou suporte. O WebSocket recebe apenas metadados de utilização.
- Uma coleta é compartilhada por todas as abas e tem cache mínimo de 1 segundo.
- Cada evento contém alguns campos numéricos pequenos; em caso de rede lenta o backend descarta amostras antes de acumular buffer.
- Não mede o consumo individual do Nginx ou PostgreSQL (o campo `node` reflete apenas este processo Node.js).
- Disco mede a partição que contém `/`, não discos secundários.

## Implantação

1. Faça backup do código atual.
2. Substitua o backend e painel com os ZIPs da mesma entrega.
3. Backend: `npm ci && npm test` (testes que dependem de PostgreSQL precisam de ambiente próprio).
4. Painel: ajuste `.env.production` com `VITE_API_URL=https://api.deltatv.com.br`, depois `npm ci && npm run build`.
5. Reinicie o backend com `pm2 restart <nome-do-processo> --update-env` e publique a pasta `dist` no Nginx do painel.
6. Acesse Sistema → Servidor / VPS com um usuário superadmin. `wss://api.deltatv.com.br/ws` deve estar liberado no Nginx existente.

Não há alterações de schema nem migrations para essa função.
