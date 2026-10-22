# Implementação Roku + licenciamento (2026-10)

## Arquitetura

- O Roku chama `GET /api/v1/client/resources` na inicialização e consulta `GET /api/v1/client/xtream` para obter `baseUrl`, `username` e `password` da ativação.
- Categorias, canais, filmes, séries e episódios são consultados diretamente na API Xtream do fornecedor. A reprodução usa as URLs `/live/`, `/movie/` e `/series/` do fornecedor; o app não chama `/play-token`.
- O Roku consulta `/status` periodicamente. Quando a ativação é bloqueada, expira ou é revogada, para a reprodução, limpa a sessão local e abre a tela de conexão. A verificação ocorre a cada 60 segundos; um stream direto pode continuar enquanto o dispositivo estiver desconectado até a próxima verificação.
- A configuração Xtream local tem cache máximo de 60 segundos. A versão de configuração retornada pelo backend permite ao Roku detectar alteração de fornecedor, limpar o catálogo local temporário e recarregar.
- Uma ativação existente pode mudar para outra parceria com código e credenciais válidos. A configuração antiga é substituída na mesma ativação, as sessões antigas são revogadas e a mudança é auditada. Se a ativação era baseada em licença, a associação à licença é liberada quando ela muda para parceria.

## PostgreSQL

A migration `20261019000001-remove-persisted-catalog.cjs` remove `catalog_items`, `catalog_series`, `catalog_groups` e `catalog_imports`. Essas tabelas guardavam importações persistentes e URLs de origem por item. Permanecem as tabelas de licenças, ativações, parceiros, fornecedores e credenciais cifradas.

Antes de executar em produção:

1. Faça backup do PostgreSQL.
2. Confirme a URL de conexão no ambiente correto, especialmente se estiver usando a URL não-pooling para migrations.
3. Execute `npm ci` e `npm run db:migrate` no diretório do backend.
4. Verifique o log da migration e confirme que as quatro tabelas de catálogo não existem mais.

A migration é destrutiva e não restaura os dados apagados. Não execute `db:migrate:undo` para tentar recuperar os catálogos.

## Configuração de build Roku

Antes de empacotar o app, configure `DeltaServerOrigin()` em `source/Config.brs` para a URL pública do backend acessível pelo Roku. Não use `localhost` ou um IP privado de desenvolvimento em uma build de produção.

## Verificação

Os arquivos JavaScript foram validados com `node --check` e os XMLs do Roku foram parseados. Os testes automatizados de backend não puderam ser executados neste ambiente porque a instalação das dependências npm não terminou corretamente; valide com `npm ci` e `npm test` em um ambiente com acesso ao registry antes da publicação.
