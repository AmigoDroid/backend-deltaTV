# DeltaTV — Backend (pacote cumulativo V4 + planos + permissões + erros pt-BR)

Arquivos relativos à raiz do projeto `backend/`. Contém todos os arquivos de backend
entregues no pacote V4 consolidado, seguidos dos hotfixes de herança universal de planos,
autorização de Meus Apps e mensagens de validação em português, nessa ordem.

Este NÃO é o repositório completo e NÃO é uma fotografia da versão publicada.
Foi montado contra o projeto `painel(5).zip` e patches conhecidos. Use `git diff`
antes do commit para não substituir uma correção posterior.

ATENÇÃO BANCO: há três migrations criadas em correções anteriores (duas V4 de apps e
uma posterior de herança). Nenhuma migration nova foi escrita neste empacotamento.
A migração de herança cria tabela de backup; é necessário inspecioná-la antes de
qualquer aplicação. NÃO execute `db:migrate` às cegas. Confira SequelizeMeta,
banco de homologação e backup antes de decidir qualquer migração pendente.

Teste focado sugerido, na raiz do backend, após `npm ci` no ambiente adequado:
`node --test tests/unit/universal-plan-inheritance.test.js tests/unit/live-package-inheritance.test.js tests/unit/service-package-app-slots.test.js tests/unit/partner-app-permissions.test.js tests/unit/validation-ptbr.test.js`
Depois rode `npm test` e verifique `npm run db:migrate:status` sem aplicar migrations.
Não foi executado teste com PostgreSQL de produção.
