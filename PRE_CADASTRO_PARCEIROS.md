# Delta TV — Pré-cadastro de parceiros por e-mail

## O que foi implementado

Admin > Parceiros > Pré-cadastro: informar nome e e-mail, marcar (opcional) "Enviar e-mail agora" e salvar. Sem marcar, permanece em "Aguardando envio" e pode enviar mais tarde. A listagem permite reenviar ou cancelar convites. O parceiro recebe um e-mail com link para `PARTNER_PORTAL_URL/#convite=...`, confirma seu nome e e-mail, informa o nome da empresa e define senha com mínimo 12 caracteres. Após a conclusão, a conta de parceiro é criada, o convite é invalidado e a pessoa pode fazer login no portal.

O link expira em 72 horas; o envio de um novo link invalida o anterior. O banco guarda somente o hash SHA-256 do token, nunca o token puro. SMTP usa o sistema existente (`SMTP_*` e `MAIL_FROM`). O link contém o token no fragmento (#), não na query. Nenhuma informação comercial ou código de parceria é criado automaticamente.

## Configuração

No `.env` do backend, confira as variáveis já usadas por seu e-mail (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`). Adicione:

```env
PARTNER_PORTAL_URL=https://parceiro.deltatv.com.br
```

O portal de parceiro deve estar na variável `CORS_ORIGINS` do backend, pois a página envia solicitações ao domínio `api.deltatv.com.br`.

## Migração obrigatória antes do deploy

Crie um backup do PostgreSQL, implante o backend, rode `npm ci` e **confira o banco em que seu comando está conectado**:

```bash
npm run db:migrate:status
npm run db:migrate
npm run db:migrate:status
```

A nova migration é `20261121000001-partner-pre-registrations.cjs` e cria apenas `partner_pre_registrations`, sem alterar as tabelas antigas. Não execute `sequelize.sync`.

## Implantação de frontend

Atualize e compile os dois projetos (Admin e Parceiro) preservando `.env.production`. Execute `npm ci && npm run build` em cada um e copie o `dist` normalmente. Não há mudanças no painel da Revenda, Node proxy, Nginx ou aplicativo Roku. Reinicie o PM2 após rodar a migration.

## Rotas

Autenticadas (`partners:read` / `partners:write`):
- `GET /api/v1/admin/partners/pre-registrations`
- `POST /api/v1/admin/partners/pre-registrations` `{name,email,sendEmail}`
- `POST /api/v1/admin/partners/pre-registrations/:preRegId/send`
- `POST /api/v1/admin/partners/pre-registrations/:preRegId/cancel`

Públicas (limitadas por IP):
- `POST /api/v1/auth/partner-invite/verify` `{token}`
- `POST /api/v1/auth/partner-invite/complete` `{token,companyName,password}`

## Regras comerciais

A parceria criada após aceite começa como tipo `content`, status `active`, sem mensalidade (`billingModel=none`) e sem códigos/servidores/licenças/créditos. O Superadmin deverá atribuir contrato, plano, vigência e permissões adequados antes da operação comercial. A vigência inicial usada pelo cadastro é de 1 ano — revise no Admin conforme contrato. O convite não ativa o Player Web automaticamente.

## Segurança, observações e testes

- Só equipe autorizada a editar parceiros pode gerar, cancelar ou reenviar.
- Conta e senha só nascem após confirmação do link; senha não vai pelo e-mail.
- Se `sendEmail` estiver marcado e SMTP falhar, o pré-cadastro permanece salvo e a resposta avisa que o envio falhou.
- Reenvio invalidará o link anterior. A tentativa repetida em menos de um minuto é limitada.
- E-mail já cadastrado como usuário/parceiro é recusado; convite expirado ou concluído não pode ser usado.
- Cadastro concluído é transacional: cria conta, parceria e registra o uso único do token.
- Testar com caixa de e-mail de homologação e PostgreSQL real antes de liberar em produção: criação com/sem envio, falha SMTP, reenvio, link vencido, uso repetido, tentativa concorrente, duplicidade de e-mail e login.
- Em produção, nunca compartilhar o link de convite nem exibir seu token em logs ou tickets de suporte.
