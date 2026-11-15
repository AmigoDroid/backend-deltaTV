# DeltaTV — correção de 404 na tela Mensagens para TVs

## Causa comprovada na fonte analisada

O componente da Revenda faz GET `/api/v1/tv-messages` e `/api/v1/tv-messages/recipients`, mas o backend não registrava essas rotas em `src/app.js`. O problema não é do WebSocket: o painel precisa de endpoints REST para lista, prévia, histórico, envio e cancelamento.

## Instalação — SOMENTE backend, painéis separados

1. Faça backup do projeto e do banco de dados. Use primeiro uma cópia de homologação.
2. Copie o ZIP para a raiz do backend: `/var/www/backend-deltaTV` (confirme o caminho real).
3. Extraia-o e instale **sem substituir app.js**:

```bash
cd /var/www/backend-deltaTV
unzip -o DeltaTV-tv-messages-backend-hotfix.zip
bash scripts/install-tv-messages.sh
node --test tests/unit/tv-messages.test.js
npm run db:migrate:status
npm run db:migrate
node --check src/app.js
```

4. Teste a API com um usuário logado na Revenda. Reinicie o processo PM2 correto somente após a migração, por exemplo `pm2 restart DeltaTV-Server --update-env` se esse for o nome atual.
5. A partir do painel logado, GET `/api/v1/tv-messages?page=1` deverá retornar `{ "data": [], "page": 1 }` quando ainda não houver comunicações. GET `/api/v1/tv-messages/recipients?page=1` deverá retornar `{ "data": [...], "total": N, "page": 1 }`.

Sem token, o código esperado após implantação é `401` (e não `404`). Um código 401 **não comprova** as consultas ao banco nem o fluxo de envio: teste autenticado.

## Endpoints novos

**Painel** (JWT administrativo ou sessão de revenda):

- `GET /api/v1/tv-messages/recipients?page=1&q=...` — TVs do escopo autorizado.
- `GET /api/v1/tv-messages?page=1` — histórico de campanhas do usuário.
- `POST /api/v1/tv-messages/preview` — `{ "audience": "selected" | "all", "deviceIds": [...] }`.
- `POST /api/v1/tv-messages` — dados da prévia, mais `title`, `message`, `expiresInDays` (1–30), `requestId` (UUID idempotente).
- `POST /api/v1/tv-messages/:id/cancel` — cancela campanhas do autor.

**TV** (JWT de telemetria, não JWT de usuário/painel):

- `GET /api/v1/client/tv-messages` — retorna até 20 mensagens pendentes para a ativação autenticada.
- `POST /api/v1/client/tv-messages/:deliveryId/read` — confirma leitura, vinculando a ativação ao token da TV.

A API não aceita `partnerId`, `activationId` ou `MAC` arbitrário do frontend para autorizar leituras ou envios. O backend seleciona destinatários dentro da parceria ou propriedade da licença; o Superadmin pode consultar toda a plataforma, mas o histórico de envios é por usuário emissor.

## Entrega em tempo real e compatibilidade

O banco armazena a campanha e uma entrega por aparelho. Após o commit, o servidor avisa dispositivos on-line com `broadcastDeviceHint({ topic: "tv-messages", activationId })` usando o canal WSS/long-poll atual. **O sinal é só uma notificação, nunca o texto da mensagem**. A TV precisa buscar a mensagem por HTTPS e enviar confirmação de leitura após exibição/aceite.

**Atenção:** esta entrega corrige a API do servidor. Não atualiza o código do aplicativo Roku/LG/Samsung. Se o app não tiver a lógica para processar `topic=tv-messages`, consultar o endpoint e confirmar leitura, o painel enviará e manterá histórico, mas o comunicado não aparecerá automaticamente na TV. O app antigo poderá continuar sem suporte, mesmo com WebSocket operacional.

O envio faz notificação ativa às primeiras 2.000 ativações. Outros destinatários recebem ao consultar a API; trata-se de proteção contra fanout excessivo. Instalações com múltiplos processos PM2 devem usar o barramento de eventos existente da aplicação para difundir os hints (já integrado pelo canal).

## Limitações / homologação pendente

- Implementação revisada estaticamente; teste real com banco PostgreSQL e migração, entrega WSS, ACKs de Roku e UI autenticada ainda precisa ser executado antes da produção.
- Em caso de versão divergente de `src/app.js`, o script para sem modificá-lo. Não sobrescreva à força.
- Essa migração é **forward-only** para preservar mensagens e recibos. Rollback de código mantém tabelas no banco.
- O painel Revenda não precisa de um novo ZIP: seu componente `TvMessages` já consome as rotas agora implementadas.
