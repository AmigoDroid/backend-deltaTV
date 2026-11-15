# DeltaTV — Venda de licenças do Master (hotfix incremental)

## A alteração que estava faltando
O Master vende **licenças**. Crédito é unidade de pagamento; Pix é pagamento em reais. A emissão própria apenas cria estoque do Master. Para vender a revendas, o Superadmin também deve autorizar **Definir preços e vender licenças** (`canSell`).

### Painel Superadmin
Na Rede de distribuição, selecione o Master principal e habilite **Definir preços e vender licenças**. Salve. Habilite **Emissão própria de licenças** separadamente se quiser que ele crie estoque sem comprar. Apenas o Master principal pode receber autorização para **emissão**. Submasters autorizados podem revender licenças do estoque, mas não emitir estoque próprio.

### Painel Revenda / Master
Nova página **Vender / comprar licenças**, centralizando:
- Oferta por créditos: comprador confirma; o backend debita créditos do comprador e transfere licenças no mesmo processo.
- Pix: conserva o fluxo Mercado Pago já implementado, com pagamento pelo comprador e entrega somente após confirmação do gateway.
- Entrega direta: transfere licenças do estoque do Master para um subordinado direto, inclusive após recebimento externo, ou sem cobrança. **O DeltaTV não confirma nem registra pagamento externo como liquidado e não gera comissão nessa modalidade.**
- Histórico: lista compras por créditos e entregas manuais. Os pedidos Pix seguem no componente existente.
- Minha rede deixa de mostrar formulários duplicados de preço e compra. A rota antiga `#/pix-master` continua disponível para favoritos, mas não aparece duplicada no menu principal.

### Segurança da entrega manual
- Apenas Masters autorizados a vender (`canSell`), nunca revendas comuns.
- Destinatário deve estar **diretamente** vinculado e ativo.
- Requer estoque disponível; saída e entrada são atômicas.
- Respeita desativação do recurso `stock` nos dois níveis.
- Idempotência por conta e UUID, com leitura para recuperar falhas de rede.
- Auditoria. Sem manipular créditos, cobranças Pix ou comissões.
- Autorização para **emissão própria** continua exclusiva do Master principal e não é herdada.

## Preparar a VPS sem sobrescrever diretamente a produção
Faça backup dos arquivos afetados e do PostgreSQL. Teste primeiro numa cópia de homologação. Não publique backend novo sem realizar a migração após testá-la.

Cada ZIP é relativo à raiz do seu projeto:
- `DeltaTV-venda-master-backend-hotfix.zip` → `/var/www/backend-deltaTV`
- `DeltaTV-venda-master-revenda-hotfix.zip` → `/var/www/revenda-DeltaTV`
- `DeltaTV-venda-master-admin-hotfix.zip` → `/var/www/painel-admin-DeltaTV`

Após extrair o **backend** de homologação:

```bash
node --check src/modules/distribution/master-license-delivery.service.js
node --check src/modules/distribution/network.routes.js
node --test tests/regression/master-license-delivery.test.js
npm run db:migrate:status
npm run db:migrate
npm run db:migrate:status
```

O comando `db:migrate` cria **somente** a nova tabela de entregas (além de quaisquer migrations anteriores pendentes). Revise as pendências antes de executar! A migração `20261215000001-master-direct-license-delivery.cjs` é aditiva e *forward-only* para preservar histórico.

Depois de migrar e testar reinicie o processo correto do backend no PM2 e verifique os logs. Para cada painel (instalado independentemente com Vite/Nginx):

```bash
npm run build
```

Só substitua os arquivos da produção depois de confirmar os builds e os fluxos em homologação.

## Testes obrigatórios em homologação
1. Criar um Master principal e liberar emissão e venda no Superadmin.
2. Emitir 5 licenças de 12 meses no estoque Master; verificar saldo +5.
3. Entregar 2 licenças a uma revenda direta; verificar -2 no Master, +2 na revenda e um histórico único.
4. Repetir o POST com a **mesma** chave; verificar que não há nova movimentação.
5. Tentar entregar a uma conta fora da rede, suspensa, sem estoque ou sem `canSell`; a API deve rejeitar.
6. Verificar que Submaster não pode emitir, mas pode vender estoque somente se autorizado.
7. Comprar por créditos; verificar débito, entrada de licenças e idempotência.
8. Pagar Pix em sandbox; garantir que licenças só entram após confirmação real, e que webhooks repetidos não duplicam.
9. Confirmar que entrega externa NÃO cria crédito, comissão nem baixa financeira fictícia.
10. Validar lista de revendas maior que 100, celular e retorno ao painel após falha de rede.

## Limitações de validação nesta entrega
Testes estáticos e sintáticos passaram. Não foi possível rodar Vite + Postgres + Mercado Pago integrado neste ambiente. Não considere a versão homologada. Esta versão não cria cobrança Pix pelo Master em nome do comprador; o comprador inicia o checkout existente. Recebimentos externos ainda não são conciliados pela plataforma.

## Rollback
Restaure os arquivos com backup, gere novamente os builds e reinicie o backend. **Não remova** a tabela de entregas ou estorne os estoques manualmente. Uma entrega já concluída requer uma operação contábil compensatória auditada.
