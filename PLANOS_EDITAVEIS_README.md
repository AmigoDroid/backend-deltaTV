# Catálogo editável de planos — Delta TV

## O que mudou

O catálogo de planos técnicos passa a ser armazenado em `service_plan_catalogs`, em vez de existir somente como constantes JavaScript. Os planos já usados (`reseller_basic`, `partner_professional`, `partner_premium`) são inseridos pela migração e conservam as mesmas chaves e recursos. Seus nomes, descrições, limites, recursos e preços de referência podem ser alterados.

**Atenção comercial:** `monthly_price_cents` é um PREÇO DE REFERÊNCIA. Editá-lo NÃO modifica uma mensalidade contratada, fatura já emitida, preço Pix, crédito ou limite comercial. O Superadmin continua negociando e ajustando a cobrança em **Contratos e mensalidades**. A cobrança automática segundo tabela de planos requer uma integração financeira separada.

## API exclusiva do Superadmin

- `GET /api/v1/admin/service-plans` — catálogo, inclusive inativos, com total de atribuições.
- `POST /api/v1/admin/service-plans` — criar um plano técnico.
- `PUT /api/v1/admin/service-plans/:key` — editar/desativar um plano.
- `DELETE /api/v1/admin/service-plans/:key` — excluir plano personalizado que não tenha atribuições.

Um plano em uso não pode ser excluído; pode ser desativado para novas atribuições. Os três planos padrão não podem ser excluídos/desativados, evitando quebrar cadastros sem plano explícito. Se uma alteração reduzir o limite abaixo do número de URLs de algum código já ativo, a API retorna HTTP 409. Os planos são escolhidos no editor de contrato do parceiro. Nenhuma edição altera automaticamente um preço/contrato existente.

## Implantação

1. Faça backup completo do PostgreSQL antes de executar migrações.
2. Instale o backend e rode `npm run db:migrate` para aplicar `20261117000001-service-plan-catalog.cjs`, **antes** de iniciar o backend atualizado.
3. Atualize o painel admin e execute `npm ci && npm run build`.
4. Valide com superadmin: listar os três planos, criar plano, atribuir a um parceiro de teste, consultar os recursos pelo portal, alterar preço de referência, desativar, tentar excluir (deve retornar 409 enquanto atribuído), reatribuir, e então excluir.
5. Evite reiniciar o serviço PM2 com código novo antes de aplicar a migração. Se necessário, mantenha backup de banco e arquivos para recuperação.

## Limites / segurança

- Backend valida limites de 1 a 8 URLs por código, tipos elegíveis, ativação de plano e privilégios.
- Contratos existentes permanecem vinculados à mesma chave. O cache é invalidado quando um plano muda.
- A exclusão usa FK com `ON DELETE RESTRICT`; não há exclusão em cascata de parceiros/ativação.
- Em múltiplos workers PM2, a invalidação de cache é local ao processo. Recomenda-se uma instância do backend para sua VPS, ou invalidação distribuída no futuro.
- Migração, queries e operações reais ainda precisam de teste PostgreSQL em homologação. Testes unitários não substituem testes integrados.
