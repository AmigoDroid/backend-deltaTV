# Delta TV — Correção de listagem Player Web (2026-11-02)

## Problemas diagnosticados
1. `GET /api/v1/content-partner/web-access` devolvia 404. Faltava registrar a rota de listagem no portal do parceiro de conteúdo. Adicionada com autenticação, paginação e filtro pelo `partnerId` do token (não aceita vínculo informado pelo cliente).
2. `GET /api/v1/partner/web-access` devolvia SequelizeDatabaseError 500. O serviço usa novas colunas em `web_accesses` e associações de `partner_codes`, criadas pela migration `20261120000001-simple-web-code-issuance.cjs`. Se a migration não foi aplicada, a consulta não pode funcionar. Este ZIP inclui a migration **original**, sem alterá-la.
3. `npm run db:migrate` estava sem `--config` e sem `--migrations-path`, apesar da configuração/migrations estarem fora dos diretórios padrão do Sequelize CLI. Corrigidos os scripts de migrate, status e seed.
4. O log do PostgreSQL agora mostra `pgCode` (SQLSTATE) e, quando disponíveis, tabela e coluna, SEM imprimir SQL, parâmetros ou credenciais.

## Deploy seguro
- Confirme backup do banco e publique este backend na pasta que o PM2 realmente executa.
- Rode `npm run db:migrate:status` para conferir as pendências; execute `npm run db:migrate` na pasta do backend para aplicá-las. Os scripts agora apontam explicitamente para `config/sequelize-cli.cjs` e `src/db/migrations`. Não execute `db:migrate:undo`.
- Reinicie `pm2 restart DeltaTV-Server --update-env`.
- Confira GET de ambas as URLs logado como usuário da revenda/parceiro, respectivamente.
- Se ainda houver 500, verifique os logs do PM2 pelo `pgCode` e tabela/coluna. `42703` indica coluna inexistente; `42P01` tabela inexistente.

## Observações
- Não modifica Nginx, roteamento proxy/redirect, streaming nem aplicativos.
- Acesso ao conteúdo continua limitado ao proprietário do código de parceria; o identificador de parceiro é obtido do token autenticado.
- A antiga migration de rede obrigatória de revendas NÃO deve ser usada.
