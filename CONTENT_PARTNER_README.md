# Portal do parceiro de conteúdo

API: `/api/v1/content-partner/*`; autenticação `/api/v1/auth/login` com `audience: "content_partner"`.
Somente contas `role=partner` com parceria `kind=content|both`. O ID da parceria vem do JWT.

## Monitoramento
Migração: `npm run db:migrate`. Ative `PROVIDER_MONITOR_ENABLED=true` **somente em UMA instância do backend** e `ENABLE_SCHEDULER=true` (ou equivalente na configuração atual). Verifica `GET /player_api.php` (sem credenciais), sem seguir redirects nem baixar body. São verificações de conectividade e latência, NÃO garantia de reprodução. Requer duas sondagens consecutivas boas para saúde e duas falhas para queda. Limite padrão: 2500 ms; timeout 4000 ms; intervalo 60 s. Variáveis `PROVIDER_MONITOR_SLOW_MS`, `PROVIDER_MONITOR_TIMEOUT_MS`, `PROVIDER_MONITOR_INTERVAL_SECONDS`.

Quando servidor usado pelo código cai, o monitor altera `partner_codes.provider_id` para outro provedor saudável da MESMA parceria. **Ativações já vinculadas mantêm `activations.provider_id`** para não quebrar credenciais existentes. Para proteção real dos clientes existentes, será necessário validar credenciais nos servidores alternativos e adicionar um resolvedor de failover por ativação. Nenhuma mudança automática nas ativações nesta versão.

Se todos os servidores ativos da parceria estiverem comprovadamente indisponíveis, tenta enviar um e-mail por código/episódio de queda ao `partners.contact_email`, usando SMTP já configurado. Envio não é garantido; falhas constam nos logs. Para grande volume, migre para fila SMTP persistente. Se SMTP não estiver configurado, não envia.

Rotas: `GET /overview`; `POST /servers`; `PATCH /servers/:id`; `PATCH /codes/:id`. Códigos existentes são exibidos (até 500), com criação e revogação validadas pelo serviço original de códigos.

Antes de publicar: testar migration em banco de homologação, medir limites, configurar DNS `parceiro.deltatv.com.br` e CORS para a origem, validar certificados. Execute apenas uma instância de monitor para evitar corridas.
