# Delta TV — Player Web por código de parceria (versão simplificada)

## Origem dos arquivos
Esta atualização parte de `deltatv_backend_ip_real_corrigido.zip` (anterior à implementação **descartada** de rede obrigatória de revendas). Não contém a migration `20261119000001-content-reseller-web-network.cjs` nem depende dela.

## Como ativar a funcionalidade
1. Faça backup do PostgreSQL. Publique o **backend novo** e execute `npm run db:migrate` (nova migration: `20261120000001-simple-web-code-issuance.cjs`) antes de reiniciar o processo PM2.
2. No Superadmin, entre na aba *Contrato de conteúdo* do parceiro, selecione a modalidade comercial (créditos, mensalidade com limite ou mensalidade ilimitada) e marque **Permitir que revendas emitam Player Web**. No modo de créditos, aloque saldo ao código.
3. No portal do parceiro, em *Códigos*, edite os códigos que podem ser usados e marque **Autorizar revendas a emitir Player Web**. O código numérico continua sendo o mesmo, de 4 a 12 dígitos.
4. Na Revenda, em *Player Web*, escolha *Emitir por código de parceria* e informe o código, usuário e senha Xtream do cliente. O servidor gera um código independente de 2 letras e 6 números. **Não é necessário criar um vínculo de conta entre revenda e parceiro.**
5. O parceiro pode ver todos os acessos oriundos dos seus códigos, inclusive nome da revenda, usuário emissor, MAC virtual, último login e credenciais reveladas somente mediante ação explícita auditada.

## Cobrança única (reutiliza o motor de ativação existente)
- Código pertencente à própria revenda: precisa ser um código com `license_months` associado a uma licença do estoque. Usa `sellFromStock` transacional no módulo de ativação. Nunca cria acesso gratuito usando código sem duração.
- Código pertencente a parceiro de conteúdo: aplica exclusivamente `ContentPartnerTerms` do **proprietário do código**. Pré-pago usa saldo alocado ao código; modalidade fixa limitada verifica cota; fixa ilimitada utiliza o contrato. O estoque da revenda **não é debitado**.
- `legacy`, contratos desativados, códigos expirados ou revogados, saldo insuficiente e códigos não autorizados são recusados.
- Duplicação de requisições: o navegador envia um `requestKey` UUID estável até a confirmação, com índice único por revenda. Isso evita criar outra ativação ao repetir a mesma operação, mesmo com queda de rede. As cobranças de conteúdo estão na mesma transação da ativação.

## Endpoints
- `POST /api/v1/partner/web-access/by-code`: `{code,username,password,label?,requestKey}` autenticado como Revenda.
- `GET /api/v1/content-partner/web-access`: lista acessos gerados por diferentes revendas com os códigos do parceiro, paginada.
- `GET /api/v1/content-partner/web-access/:id/credentials`: revelação auditada para o proprietário do código, com limite de requisições.
- `PATCH /api/v1/content-partner/codes/:id`: permite `allowWebIssuance:true|false` para cada código.
- `PUT /api/v1/admin/partners/:id/commercial`: aceita `allowWebIssuance` além do contrato.

## Limitações e proteção
- Um código de parceria seleciona a origem, mas **não contém** usuário/senha Xtream. A revenda informa as credenciais que o provedor deverá reconhecer. O backend verifica essas credenciais antes da transação de cobrança.
- A emissão só é aberta quando **o Superadmin habilita a parceria e o proprietário libera o código**. Códigos numéricos curtos não devem funcionar como uma autorização secreta por si só.
- Revendas continuam consultando só seus acessos. O parceiro vê apenas emissões feitas com códigos seus. Nenhum token de terceiro é reutilizado e nenhuma relação permanente revenda-parceiro é criada.
- O modelo mantém os acessos antigos; a listagem do proprietário do conteúdo também inclui emissões próprias anteriores à migration.
- Não altera Nginx, modos proxy/redirect, roteamento de filmes nem o aplicativo Roku.
- Novo código ou transação a serem homologados no PostgreSQL real antes de produção.

## Testes de homologação recomendados
1. Código de revenda com licença em estoque, e sem estoque; validar somente um débito.
2. Código de parceiro com créditos, com créditos insuficientes, com mensalidade limitada e ilimitada.
3. Código de outro parceiro sem autorização: HTTP 403.
4. Duas revendas usando o mesmo código: ambos aparecem no painel do proprietário, sem acesso aos dados entre revendas.
5. Duas emissões simultâneas com o mesmo `requestKey`: no máximo uma ativação e um débito.
6. Revogação/bloqueio da parceria e do código e testes de login AB123456 após bloqueio.
7. Login Web e teste de reprodução por redirect e proxy, especialmente no caso de origens Xtream com subpastas.
