# Notificações: estrutura pai/filhos

O comunicado é registrado uma única vez em `notification_campaigns` (id, título, mensagem, prioridade, remetente e data). Cada revenda destinatária recebe uma entrega filha em `partner_notifications` (id, campaign_id, partner_id, read_at e datas).

- `GET /api/v1/admin/notifications/campaigns`: um item por comunicado; contagens agregadas.
- `GET /api/v1/admin/notifications/campaigns/:id/recipients`: filhos paginados, com hora de leitura.
- `GET /api/v1/partner/notifications`: retorna apenas entregas da própria revenda, com os campos do comunicado agregados para compatibilidade com o portal já publicado.
- `POST /api/v1/admin/notifications/send`: cria pai e filhos na mesma transação; emite alertas WebSocket depois do commit.

## Migração

`20261111000001-notification-parent-child.cjs` migra os envios existentes. O mesmo `batch_id` vira pai comum dos envios em lote; registros legados sem `batch_id` ficam com um pai individual. A migração preserva `id`, `partner_id` e `read_at` de cada entrega. A nova estrutura remove título/mensagem/prioridade da tabela de entregas para evitar repetição.

Faça backup do PostgreSQL, aplique `npm run db:migrate` **antes** de iniciar o backend novo, depois faça o deploy do painel. A migração não deve ser executada por duas instâncias simultaneamente. Caso existam entregas duplicadas no mesmo lote para a mesma revenda, o índice único impedirá a migração e será necessário inspecionar os dados antes de corrigir duplicatas sem perder históricos.

**Não homologado em PostgreSQL real neste ambiente.** Testar em cópia do banco com volume representativo, incluindo envios antigos, envios em massa e leituras já efetuadas.
