# Delta TV — Central de Planos e Valores no Superadmin

Atualização: 2026-11-02

## Implementação

Novo endpoint protegido `GET /api/v1/admin/partners/contract-overview` (somente Superadmin).
Parâmetros aceitos: `q`, `kind=content|reseller`, `page`, `pageSize` (máximo 100 na validação; resposta limitada a 50 por consulta).
Retorna contratos, modalidade de cobrança, valores realmente cadastrados, planos técnicos e limites. A listagem usa uma consulta paginada de parceiros e duas consultas em lote para contratos e planos, evitando uma consulta individual por parceiro.

Novo menu no painel administrativo: Financeiro > Planos e valores.
Abas: Contratos e mensalidades / Planos de recursos / Preços das licenças.
O editor de contrato usa o endpoint existente `/admin/partners/:id/commercial`, o de recursos usa `/admin/partners/:id/service-plan`. A tabela de valores Pix utiliza `/admin/pix/prices`.

## Política comercial

Os níveis Revenda Básico, Parceiro Profissional e Parceiro Premium não têm preço-base obrigatório cadastrado no banco; definem recursos técnicos.
Os valores comerciais são negociados por cadastro. Não foi introduzida uma nova tabela de preços-base nem alteradas as regras de faturamento existentes.

## Implantação

1. Faça backup dos arquivos atuais e mantenha os `.env` (sem copiar senhas nos ZIPs).
2. Substitua o backend e o painel administrativo pelos projetos correspondentes.
3. Execute `npm ci` e `npm run build` na pasta do painel administrativo; reinicie a API usando seu fluxo PM2 habitual.
4. Entre com conta Superadmin e abra `Financeiro > Planos e valores`.
5. Teste pesquisa, paginação, edição de contrato, edição de plano e edição de preços Pix em homologação.

Sem novas migrações nesta atualização.

## Limites de validação

Verificação sintática estática do frontend e `npm run test:unit` no backend passaram. Não foi possível executar `npm run build` porque os pacotes do Vite/React não estavam disponíveis no cache npm do ambiente. Não foram executados testes integrados com PostgreSQL.
