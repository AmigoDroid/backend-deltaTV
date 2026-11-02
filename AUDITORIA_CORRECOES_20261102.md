# Delta TV — Correções de auditoria (02/11/2026)

## Entregue

1. **WebSocket / escopo**: eventos administrativos globais chegam só aos perfis administrativos; eventos de uma parceria só são entregues à própria parceria e aos administradores. Eventos agora têm `topic` por módulo para reduzir recargas de listas não relacionadas.
2. **Revogação WebSocket**: alteração sensível do usuário encerra sua conexão imediatamente, além da verificação periódica em lote de perfil, vínculo, status e `tokenVersion` (até 60 s para alterações feitas fora das rotas monitoradas).
3. **Dashboard**: faturas pendentes calculadas por SQL, dispositivos faturáveis consolidados numa consulta agrupada, cache de até 12 s e invalidação após mutações autenticadas. Totais de parceiros/revendas são agregados sem depender da primeira página do frontend.
4. **Presença**: contagens globais e por parceria consideram sinais ainda não gravados no banco, evitando divergência antes do flush de presença local.
5. **Monitoramento**: `slow` é diferente de `down`; confirmação de falha exige sondagens de verdade. Timeout padrão de 4 s permite identificar resposta de 3,05 s como lenta. Verificação prioriza provedores com medições antigas. Sondagens idênticas continuam deduplicadas. A janela de validade do resolvedor acompanha a capacidade de monitoramento.
6. **URLs Xtream**: `player_api.php` preserva subpastas do servidor, em vez de sempre ser montada na raiz do domínio. URLs com caminhos distintos não compartilham incorretamente a mesma sondagem.
7. **Notificações**: envio em lotes de até 250 destinatários dentro da transação; WebSocket avisa apenas depois do commit. Não carrega todos os objetos de entrega em memória.
8. **Paginações**: `kind` filtrado no PostgreSQL em `/api/v1/admin/partners` antes da paginação. Painel usa o filtro por tipo no servidor.
9. **Interface**: indicadores `slow` nos monitores e recarregamento mais seletivo após eventos WebSocket.
10. **Porta**: em `NODE_ENV=production`, o Node escuta somente `127.0.0.1` por padrão. Para override, `API_BIND_HOST` explícito.

## Antes da produção

- Faça **backup do PostgreSQL** e dos arquivos da versão atual; teste num ambiente de homologação.
- Não há migration nova nesta atualização; todas as migrations das versões anteriores precisam estar aplicadas.
- Use `NODE_ENV=production`, `API_BIND_HOST=127.0.0.1`, `TRUST_PROXY=loopback`, `CORS_ORIGINS=https://admin.deltatv.com.br,https://revenda.deltatv.com.br,https://parceiro.deltatv.com.br` (adicione outras origens reais que utiliza) **somente se o Nginx estiver no mesmo servidor e for o proxy confiável**.
- Confirme no Nginx `proxy_pass http://127.0.0.1:3000;` e `/ws`; valide com `sudo nginx -t` antes de reload. Não abra a porta 3000 ao público no firewall.
- `npm ci`, `npm run test:unit` no backend e `npm run build` em cada frontend; teste tokens revogados, contadores, filtros, WebSocket, login, pagamentos e failover com servidores reais antes de subir a versão.
- Em PM2, use **uma única instância para WebSocket, caches e agendador**; se escalar para múltiplos processos/servidores, será necessário um backplane compartilhado para presença, eventos e caches.
- Teste com uma URL Xtream cujo caminho inclui `/subpasta/`: o resolvedor agora usa `/subpasta/player_api.php`, não `/player_api.php` da raiz.
- Monitoramento de milhares de servidores: comece com `PROVIDER_MONITOR_CONCURRENCY=4`, ajuste `PROVIDER_MONITOR_MAX_PER_CYCLE` após medições e observe PostgreSQL/PM2. Deduplicação evita tráfego HTTP repetido, mas **não elimina todas as atualizações por cadastro no banco**.

## Pontos que exigem projeto dedicado

- **Tokens em localStorage**: não migrados nesta atualização. Migrar para sessão com cookie HttpOnly/Secure exige projeto coordenado de autenticação, CORS e CSRF nos três portais; mudar parcialmente quebraria logins.
- **Várias instâncias PM2**: a presença WebSocket ainda é mantida em memória por processo. Recomendado operar com uma instância até existir sincronização compartilhada.
- **Envio em massa enorme**: os lotes limitam RAM, mas ainda compõem uma transação PostgreSQL única, podendo mantê-la aberta por muito tempo. Para centenas de milhares de destinatários, usar fila persistente com worker.
- **Oportunidade de índices e cronograma por URL única**: requer perfil de queries (`EXPLAIN ANALYZE`) de dados reais para não criar índices ou travas desnecessárias.

## Validação realizada no ambiente de preparação

- Testes unitários do backend: **38/38** passaram.
- Verificação de sintaxe dos arquivos JavaScript/CJS do backend: passou.
- Parser React/JSX: passou em todos os arquivos presentes.
- Imports relativos: não foram identificadas referências a arquivos ausentes.
- Não foi possível completar builds React/Vite, conectar ao PostgreSQL real ou testar carga e WebSocket em navegador neste ambiente.
