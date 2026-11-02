# Monitoramento dos servidores — Admin e Revenda

## Visão geral

Reutiliza o monitor HTTP do backend (`provider-monitor/monitor.service.js`). **Abrir a página não testa servidores**: as páginas leem `provider_health` e metadados do PostgreSQL, com paginação no SQL e aviso WebSocket após alterações relevantes de saúde.

### Endpoints

- `GET /api/v1/admin/server-monitor?page=1&pageSize=20&q=&status=`: apenas usuários com `partners:read`, mostra todos os parceiros, filtros e resumo agregado.
- `GET /api/v1/partner/server-monitor?page=1&pageSize=20&q=&status=`: exige JWT de `partner`; mostra **somente** servidores cadastrados na sua própria parceria, extraindo `partnerId` do token (não aceita `partnerId` enviado pelo navegador).

Estados: `healthy` (duas sondagens boas), `suspect` (instável ou lento), `down` (duas falhas), `unknown` (sem medição recente ou monitor desligado), `disabled` (servidor desativado no cadastro). Medição antiga nunca é apresentada como confirmação de disponibilidade.

O servidor pode verificar até 60 origens por rodada, com concorrência máxima de quatro por padrão. A tela não cria novas sondagens. Eventos `changed/topic=server-health` são emitidos apenas quando há troca de estado ou mudança importante de latência. A UI tem sincronização de segurança a cada 60 segundos.

### Configuração PM2 / VPS

Em um **único processo** responsável pelo monitor, após homologação:

```
ENABLE_SCHEDULER=true
PROVIDER_MONITOR_ENABLED=true
PROVIDER_MONITOR_INTERVAL_SECONDS=60
PROVIDER_MONITOR_CONCURRENCY=4
PROVIDER_MONITOR_MAX_PER_CYCLE=60
PROVIDER_MONITOR_TIMEOUT_MS=3000
PROVIDER_MONITOR_SLOW_MS=2500
```

Se houver várias instâncias PM2, somente uma delas deve monitorar. O Nginx já encaminha as rotas `/api/v1/...` da API; não é necessário criar location adicional para estas páginas. Para atualizações imediatas, `/ws` deve estar encaminhado e autenticado; o fallback de 60 segundos também funciona sem WebSocket.

### Instalação e validação

1. Faça backup do backend e dos painéis. Mantenha o `.env` de cada instalação.
2. Atualize os três projetos coordenadamente e execute `npm ci` / `npm run build` nos dois frontends.
3. Não há migração nova nesta atualização. **As migrações anteriores do monitor (`provider_health`) precisam estar aplicadas.**
4. Teste a rota admin com superadmin; teste a rota de revenda com uma conta A e confirme que não retorna os servidores da conta B.
5. Confirme uma queda real controlada e o estado de latência; compare o tempo da última verificação. Não use apenas o status HTTP como prova da qualidade do streaming.

### Limitações

A saúde indica resposta HTTP do endpoint `player_api.php` a partir da VPS, não do dispositivo final. Alterações automáticas de URL continuam sob as regras de failover existentes. Não há teste adicional por cada acesso ao painel, nem uma garantia de disponibilidade de cada canal.
