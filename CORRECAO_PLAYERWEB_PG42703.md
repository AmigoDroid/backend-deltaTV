# Correção do erro PostgreSQL 42703 — Player Web

A migration `20261120000001-simple-web-code-issuance.cjs` está marcada como `up`, mas o modelo Sequelize possuía um campo mapeado na tabela errada:

- **INCORRETO:** `Activation.allowWebIssuance` gerava consultas a `activations.allow_web_issuance` (coluna não criada por nenhuma migration).
- **CORRETO:** `ContentPartnerTerms.allowWebIssuance` corresponde a `content_partner_terms.allow_web_issuance`, criada pela migration.
- `PartnerCode.allowWebIssuance` continua mapeado em `partner_codes` e não foi alterado.

Atualização: altera somente `src/db/models/index.js`; nenhuma migration, código de cobrança, rota ou proxy foi modificado.

## Implantação segura
1. Faça backup do backend atualmente em uso.
2. Substitua o arquivo `src/db/models/index.js` pelo novo (ou instale o ZIP completo, preservando o `.env` e outras alterações locais).
3. Reinicie: `pm2 restart DeltaTV-Server --update-env`.
4. Refaça a consulta `GET /api/v1/partner/web-access` e acompanhe `pm2 logs DeltaTV-Server --lines 40`.

**Não rode novamente as migrations:** seu `db:migrate:status` já mostrou `up` na migration do Player Web.

Se o erro 42703 persistir, confirme o nome exato da coluna no banco com um SELECT de metadados e compare se o processo do PM2 está usando o mesmo banco do sequelize-cli.
