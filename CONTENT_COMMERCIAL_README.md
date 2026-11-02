# Delta TV — Contratos de parceiros de conteúdo (2026-11-01)

Este backend foi desenvolvido em cima de `deltatv_backend_failover_inteligente.zip`.
Não substitui o painel da revenda. Integra o painel novo de parceiro de conteúdo e o Superadmin.

## Antes da VPS

1. Faça backup consistente do PostgreSQL e do backend atual.
2. Execute `npm ci` e `npm run db:migrate` com o backend novo (migração `20261114000001-content-commercial-terms.cjs`).
3. Não ligue o monitor até homologar dois URLs equivalentes que aceitem as mesmas credenciais.
4. Rode uma única instância do monitor agendado; caso use mais de um PM2, separe o scheduler ou mantenha apenas uma instância habilitada.
5. Faça `npm ci && npm run build` no portal parceiro e no admin, com `VITE_API_URL=https://api.deltatv.com.br`. O Nginx serve os arquivos estáticos; não precisa de outro Node.
6. Em ambiente de teste: escolha um parceiro de conteúdo, conceda créditos, coloque modalidade `credits`, aloque a um código, ative uma TV, confira debit/limites, tente ativação repetida e tente uma segunda ativação sem saldo.

## Contratos: estados e cobrança

- `legacy`: preserva regras antigas. Após a migração TODOS os contratos existentes continuam `legacy` por padrão (não muda clientes).
- `credits`: a administração concede créditos na carteira `credit_wallets` existente. O parceiro aloca créditos a cada código; cada nova ativação ou troca para código ainda não usado cobra `creditsPerActivation`. Login repetido com o mesmo código **não** cobra. A cobrança e a ativação pertencem à mesma transação com bloqueio de linha. Crédito já consumido não é automaticamente devolvido ao desvincular.
- `fixed_unlimited`: permite novas ativações sem limite comercial global, ainda respeitando eventual limite individual de um código. Aplica valor fixo mensal ao sistema de faturas já existente.
- `fixed_limited`: além da mensalidade fixa, limita a quantidade de ativações vivas da parceria (contagem no banco sob lock). Alterar para um limite inferior às ativações atuais não as revoga retroativamente.
- `partner_only`: mantém o vínculo de acesso com a parceria e com seu código ativo; uma revogação de código nega acesso após a expiração curta do cache (até 15 s). O endpoint de desvínculo revoga sessões e apaga credenciais no banco. NÃO apaga fisicamente o cache do aplicativo Roku — para isso será necessário implementar comando de sincronização/limpeza no app. Também NÃO cancela licenças pessoais ou vínculos de outras parcerias do mesmo aparelho.
- `standard`: preserva comportamento anterior, inclusive licenças individuais/granted independentes.

### Proteções

- Usuários `partner` só podem listar seus próprios códigos, dispositivos e saldos e só podem redistribuir créditos que já estão em sua carteira.
- Somente perfis com `billing:write` alteram o contrato e concedem/retiram créditos.
- As atribuições de crédito, contratos e consumo da ativação são auditados; a carteira possui extrato imutável.
- Valores são inteiros, com limites nas rotas. Crédito consumido não fica negativo graças às constraints do banco.
- Contratos de conteúdo `credits` não devem misturar `licenseMonths` de estoque de revenda no mesmo código, para não haver dupla cobrança. O backend rejeita essa combinação.
- O servidor mantém a URL por tempo mínimo para evitar flapping e só troca para alternativa após validar credenciais; latência da VPS não garante reprodução sem buffering.

## Rotas novas

**Admin**
- `GET /api/v1/admin/partners/:id/commercial`
- `PUT /api/v1/admin/partners/:id/commercial`
- `POST /api/v1/admin/partners/:id/commercial/credits` (ajuste de carteira com motivo)

**Parceiro (token de usuário partner com `kind=content|both`)**
- `GET /api/v1/content-partner/commercial`
- `GET /api/v1/content-partner/devices?page=1&pageSize=20&q=...`
- `POST /api/v1/content-partner/devices/:id/revoke` (revoga vínculo e credenciais)
- `POST /api/v1/content-partner/codes/:id/credits` (`quantity` positiva/negativa; não devolve saldo já consumido)
- `GET /api/v1/content-partner/codes` mostra saldo e número de ativações por código (paginado)
- `GET /api/v1/content-partner/overview` informa prioridade efetiva, calculada em memória com base em saúde/latência

## Custos e escalabilidade

- Nenhum processo separado de Node, Redis ou nova fila obrigatória.
- As verificações dos servidores continuam limitadas a 60 por ciclo com 4 chamadas simultâneas, sem buscar M3U gigante.
- As métricas são calculadas por código/página; não baixa milhares de MACs para o navegador.
- As políticas de acesso e prioridades têm cache limitado e expirável; não são escritas no banco em cada consulta.
- Atenção: login/ativação por parceiro usa transações e linhas serializadas para não vender ativações em duplicidade. Em parceiros de tráfego muito elevado, monitorar contenção de locks e adequar planos.

## Validação / pendências de homologação

`node --test tests/unit/*.test.js` cobre políticas puras e estabilidade de ranking. O código foi verificado por sintaxe JavaScript/TSX. Ainda é obrigatório testar MIGRATION e transações com Postgres real, `npm run build` nos dois frontends, login, ativação concorrente, revogação e failover ponta a ponta.

Não gera mensalidades automaticamente fora do mecanismo de `billingModel=fixed` já existente. O valor de referência é mensal, não é uma cobrança automática por cartão.
