# Delta TV — resolvedor inteligente de servidores (VPS 2 GB / 2 vCPU)

## O que foi alterado

- Um **código de parceria** pode ter de 1 a 8 **servidores ativos do mesmo parceiro** (`code_server_pools`). Servidores são cadastros `partner_providers`, não URLs arbitrárias da TV.
- No portal do parceiro (`parceiro.deltatv.com.br`), em **Códigos → Configurar URLs**, escolha os servidores daquela lista. A primeira URL selecionada será a referência principal para o código.
- Quando a TV solicita `GET /api/v1/client/xtream`, ou usa as rotas de catálogo Xtream e playlist, a API escolhe o servidor saudável mais rápido **medido da VPS** entre os permitidos para o código. O código e a licença não mudam e **não há atualizações em massa de ativações**.
- URLs alternativas são usadas somente após a API validar que **usuário/senha daquela ativação** funcionam na URL alternativa. URLs que não aceitam as credenciais são ignoradas. A autenticação não faz download de catálogo nem de M3U.
- Alterações de URL em tempo real não são feitas durante um stream já aberto; passam a valer na próxima consulta/reconexão, ou após expirar o cache curto do espelho.
- Contas e listas próprias que não usam código de parceiro preservam seu comportamento.

## Custos e proteções

- Monitoramento por `GET /player_api.php`, sem baixar body e sem seguir redirects; verificação SSRF/DNS, timeout curto, concorrência 4 (máximo 8) e limite de 60 servidores por ciclo (máximo 250).
- 2 falhas consecutivas para marcar DOWN; 2 respostas boas para marcar HEALTHY. Pode acontecer de um link responder HTTP mas não entregar mídia. Não garante que catálogos/IDs de streams sejam idênticos entre URLs.
- Resolvedor: lista de servidores em cache 30 s (até 1500 códigos), saúde em cache 20 s (até 1000 pools), afinidade por ativação 120 s (até 5000 entradas), comprovação de credenciais em cache 10 min (até 3500 entradas), 6 validações simultâneas no máximo; sob pico, preserva a origem original em vez de enfileirar centenas de conexões.
- A seleção só muda por falha ou vantagem de pelo menos 50 ms **e** 15% após expirar a janela de estabilidade. Se todas as opções estiverem indisponíveis, retorna à configuração original — nunca inventa URL ou entrega credenciais a servidor fora da parceria.
- O alerta SMTP é separado do loop de sondagens e roda periodicamente, para não bloquear medições. A notificação por e-mail é limitada a 20 códigos por rodada e requer SMTP e e-mail de contato válidos; **não existe fila SMTP durável nesta versão**.
- Nenhum cache possui tamanho ilimitado e nenhuma operação cria processos extras. Backend continua Node + PM2 + Nginx existentes.

## Instalação segura

1. Fazer backup do PostgreSQL e preservar seu `.env` antes de trocar os arquivos.
2. Atualizar o backend mantendo o processo **antigo** em execução, executar `npm ci` se preciso e `npm run db:migrate`. A migração nova é `20261113000001-code-server-pools.cjs`. Nunca usar `sequelize.sync` nem `db:migrate:undo:all`.
3. Publicar o novo backend com `PROVIDER_MONITOR_ENABLED=false`. Testar login, revendas, licenças e dispositivo. Atualizar o portal do parceiro com `npm ci && npm run build`, mantendo `VITE_API_URL=https://api.deltatv.com.br` em `.env.production`.
4. No portal do parceiro, cadastrar URLs alternativas equivalentes, selecionar URLs de cada código. Verificar que credenciais de **teste** funcionam nas alternativas e que IDs de canais/filmes são compatíveis.
5. Na **instância única** do backend responsável pelos jobs, definir `ENABLE_SCHEDULER=true`, `PROVIDER_MONITOR_ENABLED=true`, `PROVIDER_SMART_RESOLVER=true`, `PROVIDER_MONITOR_INTERVAL_SECONDS=60`, `PROVIDER_MONITOR_TIMEOUT_MS=3000`, `PROVIDER_MONITOR_CONCURRENCY=4`, `PROVIDER_MONITOR_MAX_PER_CYCLE=60`; configurar SMTP se desejar alertas. Reiniciar **somente** a API pelo PM2 após salvar as variáveis e observar logs.
6. Testar com **um código piloto** e dispositivo de homologação antes de ativar para todos. Desabilitar `PROVIDER_MONITOR_ENABLED` e reiniciar o PM2 para rollback funcional sem apagar o novo banco.

## Observações

- `PROVIDER_MONITOR_ENABLED=false` conserva o comportamento legado de cada ativação. `PROVIDER_SMART_RESOLVER=false` desabilita apenas a seleção dinâmica, mesmo com o monitor ligado.
- A TV só recebe a nova URL quando consulta configuração ou catálogo na API novamente. Se uma TV ignora a API e usa uma URL antiga armazenada localmente sem atualizar, será necessário atualizar o cliente Roku/Tizen/etc.
- `code_server_pools` não altera automaticamente `activations.provider_id`: este é o ponto de referência e fallback seguro para credenciais existentes. O monitor novo **não** regrava `partner_codes.provider_id` ao observar falha de rede.
- A latência medida é entre VPS e origem; não necessariamente a menor latência entre TV e origem.
- **Não homologado** contra banco real/provedores reais nesta entrega. Validar migration, WebSocket, failover, rede, conta e reprodução em ambiente de teste antes de publicar em produção.
