# Diagnóstico: apps derrubando o servidor com requisições (e como ficou)

## Regra adotada
- **Controle** (status, rota/DNS, listas, comandos, telemetria, avisos, latência) = **WebSocket** (`wss://api.deltatv.com.br/ws/device`).
- **HTTP** só para: **conteúdo** (catálogo paginado, imagens, vídeo) e **Roku antigo sem WebSocket** (long-poll de 1 conexão aberta ~40 s).
- O WebSocket **avisa** ("mudou algo"); o app **nunca** responde a um aviso com uma rajada de requisições: espera um tempo aleatório (jitter) e usa o próprio WebSocket.

## O que estava causando o "DDoS"
| # | Problema | Onde | Efeito | Correção |
|---|----------|------|--------|----------|
| 1 | Contador de eventos zerava a cada reinício/deploy | `realtime/device-channel.js` | Todas as TVs em long-poll recebiam `reconnect` juntas e consultavam o servidor ao mesmo tempo | Contador começa em epoch (segundos); `reconnect` agora é espalhado (3–30 s) |
| 2 | Long-poll lotado (>4500) respondia **200 vazio na hora** | `legacyPoll` | O app repetia a chamada sem pausa: laço de requisições, 429 em seguida | Responde **503 + Retry-After 30–60 s**; app espera ≥ 4 s entre respostas rápidas |
| 3 | Qualquer edição de parceiro/código/servidor mandava aviso **global** a TODAS as TVs | `app.js` | Cada TV consultava status+listas+DNS; várias edições = onda contínua | Aviso restrito ao parceiro dono da mudança; avisos iguais em 2,5 s são fundidos |
| 4 | Rotas `/api/v1/client/*` (status, listas, catálogo, xtream) com limite **600/min por IP** | `app.js`, `security.js` | IP compartilhado (CGNAT): centenas de TVs dividem 600/min → 429 para todas | Limite **por aparelho** (token): 300/min; sem token mantém por IP |
| 5 | Status consultado **todo minuto** por TV (HTTP quando sem WS) | `MainScene.brs` | 1 req/min/TV só para "ainda estou válido?" | Rede de segurança a cada ~5 min + jitter; mudanças chegam por aviso |
| 6 | Falha/429 → nova tentativa em 2–5 s | `DeviceRealtimeTask.brs` | Servidor sobrecarregado recebia **mais** carga | Backoff 5 s → 20–40 s → 60–120 s; 429/503 → 45–90 s |
| 7 | Timeout do WS caía para HTTP em todas as TVs | `MainScene.brs` | Servidor lento = duplicava a carga por HTTP | Com o socket conectado, status/listas **não** caem para HTTP (só em queda real do transporte) |
| 8 | Reconexão: lista + DNS + status todos imediatos (e lista duplicada) | `MainScene.brs` | Após reinício: 3 operações × milhares de TVs de uma vez | Lista só se a última sync > 10 min; DNS/status seguem o jitter |
| 9 | Sonda de latência HTTP a cada 2 min (2 requisições) | `DeviceRealtimeTask.brs` | Carga constante no modo legado | A cada 15 min |
| 10 | Task de tempo real parada era recriada a cada 35 s | `ConnectionAudit.brs` | Sessão recusada → reconexão infinita | No máximo 1 recriação por 3 min |
| 11 | Long-poll reautenticava no banco (2 consultas) a cada chamada | `device-channel.js` | Carga de banco proporcional às TVs | Cache de 20 s da autorização |
| 12 | White-label: atualização de aparência a cada 5 min | `roku-template/MainScene.xml` | Requisição periódica por TV | A cada 30 min |

## Ainda é HTTP (e por quê)
- Catálogo paginado, imagens e vídeo: conteúdo, não cabe em WebSocket.
- Roku sem `roWebSocket` (conforme o código, só OS 16+ usa WSS): usa long-poll. É a emulação de WebSocket via HTTPS; mantém **1 conexão aberta**, não polling rápido.
- **App white-label gerado pelo painel (`roku-template`) não tem canal em tempo real** (não existe `DeviceRealtimeTask` nele): continua HTTP (status a cada 5 min + aparência a cada 30 min). Portar o canal exige um token de telemetria no fluxo white-label: ficou como próximo passo.

## Como confirmar no servidor (antes e depois)
```
# Rotas que mais devolveram 429 (formato combined do nginx)
grep ' 429 ' /var/log/nginx/access.log | awk '{print $7}' | cut -d'?' -f1 | sort | uniq -c | sort -rn | head
# Conexões WS e long-poll em espera: GET /api/v1/... currentDeviceChannelStats() (websocket, waitingPolls)
```
Se o bloqueio vier de fora do app (fail2ban, Cloudflare, `limit_req` do nginx), ele não aparece nesse log com 429 do Express: verifique também esses.

## Ajustes opcionais de capacidade
`DEVICE_POLL_MAX_WAITERS` (padrão 4500) e `DEVICE_WS_MAX_PEERS` (padrão 5000): aumente conforme o nº de TVs, junto com `worker_connections` do nginx e o limite de arquivos abertos do Node/PM2.

## Ordem de publicação
1. Backend (`painel/backend-deltaTV`) + `pm2 reload`. 2. Painéis (`npm ci && npm run build`). 3. Novos pacotes Roku (Delta build 69, Dream build 2). TVs antigas já melhoram só com o backend (itens 1–4, 11).
