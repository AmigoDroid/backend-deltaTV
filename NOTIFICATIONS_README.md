# Notificações internas Delta TV

Execute `npm run db:migrate` antes de iniciar o backend atualizado. Publicação: backend + painel admin + portal revenda devem ser atualizados juntos.

API:
- `POST /api/v1/admin/notifications/send` (somente superadmin): `{ audience: "all"|"selected", partnerIds: [], title, message, severity: "info"|"important"|"warning" }`
- `GET /api/v1/admin/notifications/history` (superadmin)
- `GET /api/v1/partner/notifications` (somente usuário parceiro, escopo do token)
- `PATCH /api/v1/partner/notifications/:id/read`
- `POST /api/v1/partner/notifications/read-all`

Mensagens são persistentes; websocket emite somente o ID e a tela consulta a API. Teste envio global, específico, conta de outra revenda, revenda offline e reconexão. Histórico admin mostra as 20 entregas individuais mais recentes; não é uma visão agrupada por campanha. Presença WebSocket em múltiplas instâncias requer um barramento de eventos compartilhado.
