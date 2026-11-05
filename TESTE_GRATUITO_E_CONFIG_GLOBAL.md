# Teste gratuito e configurações gerais do PlayerWeb

## Teste gratuito
Painel Superadmin → Licenças individuais → Teste gratuito.
Padrão: habilitado, 30 dias. É possível desativar ou escolher de 1 a 365 dias.
A licença começa no primeiro cadastro do novo MAC e dura a quantidade exata de dias configurada, sem depender do mês do calendário. Ela usa o mecanismo normal de licenças e expiração da plataforma.
Cada MAC recebe o benefício uma única vez. Reinstalar, registrar novamente ou excluir/recriar o mesmo MAC não reinicia o teste. O identificador disponível é o MAC; um MAC diferente é tratado como outra identidade de dispositivo.
Os dispositivos já cadastrados na data da migration ficam fora da promoção automática. Alterar o prazo ou desativar o benefício afeta as próximas concessões; licenças já emitidas mantêm seu vencimento.
A concessão cria uma licença individual de teste e seu vínculo no aparelho, sem débito de créditos ou estoque. O cliente fornece a própria lista. As regras comerciais dos códigos de parceiro/revenda continuam sendo aplicadas normalmente.
Na ativação diretamente com uma licença paga, o aparelho já entra com essa licença e não ganha uma segunda licença promocional. Se ele começou pelo teste e depois informar uma licença paga, a ativação reaproveita o vínculo e a lista já configurada, substitui a licença de teste e preserva a auditoria. Também é possível renovar pelo painel escolhendo um plano comercial ativo.
A licença de teste aparece identificada em Licenças e na ficha do MAC. O histórico registra a concessão e a substituição por licença paga.

## Configurações gerais do PlayerWeb
Painel Superadmin → PlayerWeb → Configurações.
Esta é uma configuração geral, fora da janela Novo acesso web.
- HTTPS automático: vale para todas as listas de parceria do PlayerWeb, incluindo acessos existentes. Ao desativar, usa o protocolo original do parceiro. Os antigos valores de HTTPS por acesso deixam de prevalecer.
- Entrega padrão: catálogo, TV ao vivo, filmes e séries podem ter proxy ou redirecionamento como padrão. Esses valores são usados nos novos acessos e ao restaurar a entrega padrão de um código. Personalizações existentes de entrega permanecem.
A janela de criação carrega os modos padrão atuais e não mostra mais a opção de HTTPS.
Os controles gerais são exclusivos do superadmin; a API também verifica essa permissão.
As configurações de teste e de PlayerWeb são salvas separadamente para evitar que uma tela sobrescreva alterações da outra. A seleção de URLs alternativas usa o HTTPS global também. O cache do espelho é invalidado ao salvar; em outras instâncias do servidor a política web é relida em até cinco segundos.
HTTPS precisa estar disponível no servidor e na porta escolhida, com certificado válido. Portas personalizadas são preservadas. As regras de CORS do provedor continuam aplicáveis ao acesso direto pelo navegador.

## Roku — build 00040
O ZIP do app mantém a base v1.0.1 e avança para build 00040. Ajusta a mensagem de configuração para informar o teste gratuito e sua data de vencimento quando o servidor retornar esses dados. A licença é emitida e validada pelo backend.
A conclusão do pareamento aguarda uma lista configurada: o teste sozinho não consome o registro/QR antes da configuração. Assim o cliente pode enviar sua lista usando o MAC e o fluxo existente do site.
O app continua começando sem conteúdo próprio ou lista de demonstração.

## Aplicação na VPS
1. Preserve os .env e substitua os arquivos do backend e do admin pelos pacotes atualizados.
2. No backend, execute npm run db:migrate antes de reiniciar a aplicação. A migration nova é 20261125000001-platform-defaults-device-trial.cjs. Ela cria as configurações gerais, o registro de benefício por MAC, a identificação da licença de teste e o plano interno. Os modos iniciais respeitam WEB_DELIVERY_DEFAULTS quando essa variável está disponível no ambiente da migration.
3. Reinicie o backend. Se usar modo watch, pare o processo durante a substituição/migration.
4. No admin, execute npm ci e npm run build com o .env atual. Publique o dist no diretório servido pelo Nginx e recarregue o navegador com Ctrl+Shift+R.
5. Instale/teste a build 00040 no Roku para ver a nova mensagem. Configure os dois padrões pelo painel nos caminhos acima.
Não é necessário adicionar variável ao .env.
As melhorias anteriores de parceiros e dispositivos por MAC estão incluídas.

## Validação local
33 testes de regressão passaram. Incluem PostgreSQL embarcado (PGlite) para migration, prazo, repetição do benefício, expiração e rollback, além de fluxos simulados de pareamento e substituição por licença paga. A compilação do admin e a validação estática BrightScript/XML do Roku passaram.
Não houve acesso à VPS, PostgreSQL de produção, provedores reais ou teste de execução em TV física.
Rodar testes no backend: NODE_ENV=test node --experimental-test-module-mocks --test --test-concurrency=1 tests/regression/*.mjs
