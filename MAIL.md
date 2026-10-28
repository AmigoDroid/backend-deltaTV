# E-mails do painel (revendas e clientes)

Menu **E-mails** (só superadmin). Escreva a mensagem, escolha o público, clique em **Ver destinatários** e depois **Enviar**.
O envio entra numa fila e sai no ritmo `MAIL_RATE_PER_MINUTE`; o histórico mostra quem recebeu, quem falhou e por quê
(**Reenviar falhas** / **Cancelar pendentes**). Variáveis no texto: `{{nome}}` e `{{email}}`.

## Públicos
| Público | Quem recebe |
|---|---|
| Revendas ativas | Parceiros `kind = reseller` ativos: e-mail de contato da parceria; sem ele, os usuários ativos do portal dela |
| Parceiros ativos | O mesmo, para todos os tipos de parceiro |
| Uma parceria | A escolhida (qualquer status) |
| Clientes | Tabela `customers` com e-mail preenchido (clientes de licença individual) |
| Lista | Os e-mails digitados (inválidos são ignorados e contados) |

E-mails repetidos são unidos. O teto por envio é `MAIL_MAX_RECIPIENTS` (2000).

## Configuração (.env do backend)
```
SMTP_HOST=smtp.seuprovedor.com
SMTP_PORT=587
SMTP_SECURE=false        # true só na porta 465
SMTP_USER=...
SMTP_PASS=...
MAIL_FROM="DeltaTV <no-reply@seudominio.com>"
MAIL_REPLY_TO=suporte@seudominio.com   # opcional
MAIL_RATE_PER_MINUTE=30
```
Depois: `npm install`, `npm run db:migrate` e reinicie. Sem `SMTP_HOST` + `MAIL_FROM` o envio fica desligado e o painel avisa.
Use **Enviar teste para mim** para validar a conexão (mostra o erro real do SMTP).

## Entrega (importante)
Não rode um servidor de e-mail próprio (Postfix) na VPS: a maioria dos provedores bloqueia a porta 25 e IP novo cai em spam.
Use um SMTP autenticado (Brevo, Amazon SES, Resend, Zoho, Gmail com senha de app) e, no DNS do seu domínio, configure
**SPF**, **DKIM** e **DMARC** conforme o provedor. O remetente (`MAIL_FROM`) deve ser do domínio verificado.

## Limites
- Não trata *bounce*/descadastro automático: o rodapé pede resposta para remoção. Para campanhas grandes a clientes finais, mantenha uma lista de quem pediu para sair.
- A senha do SMTP fica só no `.env`; nunca vai ao banco, à auditoria ou ao painel. Cada envio é auditado (`mail.send`, `mail.retry`, `mail.cancel`).
