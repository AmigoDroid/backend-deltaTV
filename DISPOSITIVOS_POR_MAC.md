# Dispositivos — uma linha por MAC e histórico por aparelho

## Tela principal
Cada aparelho identificado por MAC aparece uma única vez, independentemente da quantidade de parceiros/listas ou de ativações antigas removidas. A paginação e os totais são feitos por aparelho no banco de dados.
A linha mostra plataforma, presença online/offline, quantidade de listas atuais, parceiros vinculados e situação dos vínculos. Aparelhos cadastrados com MAC e sem listas também aparecem, identificados como Sem vínculo.

Clique no MAC ou em Detalhes e listas para abrir a ficha:
- Listas atuais: os vínculos ativos ou bloqueados, com entrega e datas. Bloquear, desbloquear, editar e remover ficam associados à lista escolhida.
- Removidas: ativações revogadas do aparelho. O superadmin mantém as opções de restauração e exclusão definitiva sujeitas às validações existentes.
- Histórico: alterações com data, responsável, motivo registrado e resultado, em páginas de vinte eventos. Inclui eventos auditados de ativações excluídas definitivamente quando associados ao MAC e configurações do PlayerWeb vinculado ao aparelho.

Adicionar / configurar listas abre o gerenciador existente do MAC. Excluir aparelho e todos os vínculos continua exclusivo do superadmin, com prévia e confirmação do MAC.

## Filtros
- Com vínculo ativo: pelo menos uma ativação no estado ativo.
- Somente bloqueados: sem ativação ativa e com pelo menos uma bloqueada.
- Somente removidos: possui ativações, todas revogadas.
- Sem vínculo: aparelho cadastrado sem ativações.
- Online/offline: mantém a presença do aparelho.

Esses filtros resumem o estado dos vínculos. Dentro da ficha, cada lista mostra também sua decisão de acesso/licença.

## Histórico disponível
A tela utiliza a auditoria já existente e identifica o responsável pelo nome gravado no evento ou pelo usuário correspondente. Operações antigas sem auditoria/autoria não podem ser reconstruídas. Aberturas recorrentes do aplicativo, consultas de dispositivo e login do PlayerWeb ficam fora da lista de alterações para reduzir ruído.
As listas removidas continuam acessíveis dentro da ficha. O histórico antigo passa a ter paginação, substituindo o corte fixo de duzentos eventos.

## Aplicação
1. Preserve os .env de produção e substitua os arquivos de backend e admin pelos pacotes atualizados.
2. No backend, rode npm run db:migrate antes de reiniciar. A migration 20261124000001-audit-device-mac-index.cjs adiciona um índice de auditoria por MAC/data para acelerar a consulta ao histórico. Ela não reagrupa nem altera as ativações existentes.
3. Reinicie o backend. Se estiver em modo watch, pare o processo durante a substituição e a migration.
4. No admin, rode npm ci e npm run build com o .env existente. Publique o dist no diretório servido pelo Nginx.
5. Recarregue o painel com Ctrl+Shift+R.

As melhorias anteriores da tela de parceiros e do HTTPS do PlayerWeb estão incluídas, com as respectivas migrations. Não é preciso mudar o .env.

## Validação
Compilação de produção do admin e 25 testes de regressão aprovados. Os quatro testes novos executam os filtros e a paginação gerados pelo Sequelize em PostgreSQL embarcado (PGlite), com múltiplos vínculos do mesmo MAC, estados mistos, busca parcial, online/offline, histórico paginado, autoria e índice reversível.
Teste geral no backend:
  NODE_ENV=test node --experimental-test-module-mocks --test --test-concurrency=1 tests/regression/*.mjs

Não houve acesso à VPS ou ao banco de produção.
