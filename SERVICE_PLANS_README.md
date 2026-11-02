# Planos de recursos — Delta TV

**Arquitetura:** o nível de serviço técnico é separado do contrato financeiro (`content_partner_terms`). Os níveis não fazem cobrança automaticamente; preços e limites de licenças continuam configuráveis no Superadmin em Contrato de conteúdo.

| Plano | URLs por código | Failover | Prioridade automática | Alerta por e-mail | Histórico de mudanças |
|---|---:|---|---|---|---|
| Revenda Básico | 1 | não | não | não | só estado atual |
| Parceiro Profissional | 4 | sim | não (prioridade manual) | sim | estado atual |
| Parceiro Premium | 8 | sim | sim, respeitando controle antigo do contrato | sim | até 50 mudanças recentes, retenção 30 dias |

O Superadmin pode alterar separadamente limite de URLs, failover, prioridade, alertas e histórico de um parceiro. O **backend** valida todos os limites. O usuário parceiro não pode modificar o próprio plano.

## Migração e compatibilidade

- `20261115000001-partner-service-plans.cjs`: cria a tabela dos planos e atribui **Premium às contas de conteúdo já existentes** para preservar o acesso anterior de até oito servidores; revendas existentes recebem Básico. Para novas contas sem linha explícita, o padrão é Básico para revenda e Profissional para conteúdo.
- `20261115000002-provider-health-history.cjs`: histórico compacto de mudança de estado (não registra cada sondagem).
- A tentativa de mudar para um plano que comporte menos URLs que as atualmente ligadas a um código ativo retorna `409 SERVER_POOL_EXCEEDS_PLAN`, sem retirar o acesso dos clientes. Ajuste os códigos primeiro.
- `GET /api/v1/admin/partners/:id/service-plan` e `PUT /api/v1/admin/partners/:id/service-plan` (edição: **superadmin**).
- `GET /api/v1/content-partner/service-plan` e `GET /api/v1/partner/service-plan` consultam o plano da própria conta.
- `GET /api/v1/content-partner/servers/:id/history` disponível somente para contas com histórico detalhado, limitado à parceria autenticada.
- O `PROVIDER_MONITOR_ENABLED` e o `PROVIDER_SMART_RESOLVER` continuam desativados/optativos conforme as configurações anteriores.

## Desempenho

- Cache de características por parceiro de 20 segundos, com máximo de mil entradas. Salvamento de plano limpa o cache local, cache de seleção e validações.
- Sem processo Node adicional, sem Redis. A tabela de histórico recebe uma linha apenas em mudança de estado. Registros com mais de 30 dias são removidos no máximo uma vez por dia enquanto o monitor estiver ativo.
- O Superadmin e o parceiro usam consultas já existentes e não forçam sondagens ao abrir a tela.
- Em PM2 **cluster** com mais de um worker, o cache dos outros workers pode levar até 20 s para expirar. Para este deployment recomenda-se uma instância ou um mecanismo de invalidação compartilhado.

## Implantação segura

1. Faça um backup do banco e mantenha a release anterior para rollback.
2. Execute `npm run db:migrate` com as duas novas migrations antes de iniciar o backend novo.
3. Publique backend e painéis em sequência; execute `npm ci && npm run build` em cada painel.
4. Teste um código antigo e um novo, cada nível de plano, troca de servidor, limite de URLs, envio SMTP e status HTTP.
5. Ative o monitor e o resolvedor apenas depois da homologação local.

**Não homologado:** migrações e integração com PostgreSQL, SMTP e TVs reais precisam de testes no ambiente de homologação. Os testes unitários não substituem esses testes.
