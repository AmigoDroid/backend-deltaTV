# Presença online/offline de dispositivos

## Como funciona
- **Online** = o aparelho deu sinal nos últimos `PRESENCE_WINDOW_SECONDS` (padrão 90 s).
- **Sinais** (só gravam em memória, sem I/O): requisição autenticada do app, reprodução (token play / rota espelho Xtream) e o
  **heartbeat** `POST /api/v1/client/heartbeat`.
- A cada `PRESENCE_FLUSH_SECONDS` (15 s) os sinais vão para `devices.last_seen_at` em **um único UPDATE em lote**. Sem tabela nova, sem WebSocket.
- Leitura = maior valor entre a memória do processo e o banco (funciona com várias instâncias).

## Instalar
1. Copie `backend/`, `admin/` e `revenda/` desta pasta por cima dos projetos.
2. `npm run db:migrate` (cria só um índice em `devices.last_seen_at`).
3. Reinicie a API. (Opcional, `.env`): `PRESENCE_WINDOW_SECONDS=90`, `PRESENCE_FLUSH_SECONDS=15`, `PRESENCE_HEARTBEAT_SECONDS=30`.
4. `npm run test:unit`.

## O que o APP precisa fazer
Enquanto aberto, a cada `intervalSeconds` (começa em 30):
```
POST /api/v1/client/heartbeat
Authorization: Bearer <accessToken>
→ 200 { "ok": true, "intervalSeconds": 30, "serverTime": "..." }
```
401 = token vencido → renovar em `/session/refresh` e repetir. Bloqueado/expirado também responde 200.
Sem o heartbeat uma TV parada num menu ou numa conexão longa pode aparecer offline após 90 s.

## API
- Admin: `GET /admin/devices` (+ `online`, `lastSeenAt`, filtro `?online=true|false`) e `GET /admin/devices/presence`.
- Revendedor: `GET /partner/devices` (+ `online`, `lastSeenAt`, filtro `?online=`) e `GET /partner/devices/presence`
  (conta só os aparelhos com ativação ativa do próprio parceiro; o partnerId vem do token).
- `online` também em: dispositivos sem vínculo, consulta por MAC e lista de licenças do revendedor.

## Telas
- **Admin:** coluna Conexão + filtro em Dispositivos (auto-atualiza a cada 20 s), card “Online agora” no Dashboard, badge em Sem vínculo e na consulta por MAC.
- **Revendedor:** coluna Conexão + filtro Online/Offline em Dispositivos (auto-atualiza a cada 20 s), card “Online agora” na Home
  (clique abre Dispositivos), badge na busca por MAC, no modal de Listas e em Licenças › Aparelhos.

## Observações
- Com várias instâncias, o banco enxerga o sinal com até `PRESENCE_FLUSH_SECONDS` de atraso (a janela de 90 s absorve).
- Não testado contra PostgreSQL real nem com `vite build` (ambiente sem rede): lógica coberta por testes unitários e telas
  verificadas só quanto à sintaxe. Rode `db:migrate` e abra os painéis uma vez em desenvolvimento.
