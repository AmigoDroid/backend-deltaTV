# Histórico detalhado de servidores — Superadmin

## Acesso
- Monitoramento → Histórico detalhado no cartão do servidor.
- Parceiros → abrir a parceria → Servidores → menu do servidor → Histórico detalhado.

O superadmin pode consultar qualquer servidor existente, independentemente do plano da parceria. O histórico do parceiro continua com o mesmo escopo e as regras de plano que já existiam.

## Informações
Data e hora, estado de saúde, latência em milissegundos e observação/motivo registrado. Há filtro por estado e paginação de vinte eventos por página, sem o corte fixo de cinquenta registros do portal do parceiro.
São registros de mudanças de estado, não uma medição por minuto. A retenção do monitor permanece em trinta dias. Abrir o histórico apenas lê a telemetria existente, sem sondar o provedor novamente. Servidores sem eventos exibem a mensagem correspondente.
O endpoint exige autorização de superadmin no backend, além do botão exclusivo na interface. Administradores comuns, suporte, parceiros e requisições sem usuário não recebem acesso a essa rota administrativa.

## Aplicação
Esta correção não adiciona migration. Preserve os .env, substitua o código do backend e reinicie o processo. No admin, execute npm ci e npm run build com o .env de produção existente, publique o dist e recarregue o painel com Ctrl+Shift+R.
Se ainda não aplicou as versões anteriores, execute também npm run db:migrate para suas migrations pendentes.
Os pacotes preservam o teste gratuito padrão de sete dias, as configurações gerais do PlayerWeb e os ajustes anteriores de parceiros/dispositivos por MAC.

## Validação
Compilação do admin aprovada. Três testes novos passaram com PostgreSQL embarcado (PGlite), cobrindo acesso a servidores de diferentes parcerias sem consulta de plano, paginação, filtro, isolamento dos registros por servidor, dados detalhados, UUID inválido, servidor inexistente e bloqueio de perfis sem autorização.
Rodar no backend: NODE_ENV=test node --test tests/regression/superadmin-server-history.mjs
Não houve acesso à VPS ou ao banco de produção.
