# Parceiros: pendências, configuração e histórico

## Comportamento
A lista principal de parceiros permanece em destaque. O antigo bloco grande foi substituído por um resumo compacto com quantidade de pendências e os botões Gerenciar convites e Pré-cadastro.

Gerenciar convites abre uma janela com Pendentes e Histórico, com oito registros por página e rolagem interna. Convites cancelados ficam no histórico. Um cadastro concluído pelo parceiro fica pendente apenas enquanto falta a configuração administrativa.

Ao salvar Editar condições ou Contrato de conteúdo, o pré-cadastro é marcado como configurado na mesma transação e sai das pendências. O parceiro e seu acesso continuam disponíveis na lista principal. Abrir a parceria ou fechar a janela sem salvar não finaliza a configuração.

Para parceiros já configurados, use Concluir configuração na lista de pendências. Esse botão apenas registra que a configuração terminou; não altera valores, contrato, servidores, códigos ou usuário. O registro continua acessível no Histórico, com Abrir parceria.

A migration reconhece também configurações antigas quando há auditoria de partner.update ou content.terms.update por administrador com sucesso após a conclusão do convite. Sem essa evidência, o item aguarda a ação Concluir configuração ou um novo salvamento administrativo. Nenhum parceiro é apagado.

## Aplicação — esta versão exige migration
1. Preserve os .env existentes e substitua o código-fonte do backend e do admin pelos respectivos pacotes.
2. Na pasta do backend, rode:

   npm run db:migrate

   Isso adiciona configured_at ao pré-cadastro, cria um índice e reconhece configurações antigas pela auditoria. Se o processo estiver em modo de reinício automático ao alterar arquivos, pare-o durante a substituição e a migration.
3. Reinicie o backend usando o gerenciador da VPS.
4. Na pasta do admin, rode npm ci e npm run build com o .env de produção existente. Publique o dist gerado no diretório servido pelo Nginx.
5. Recarregue o painel com Ctrl+Shift+R.

Não é necessário alterar o .env nem cadastrar novamente os parceiros. Os ZIPs contêm código-fonte, sem node_modules ou dist de testes.

## Validação
- Compilação de produção do admin aprovada.
- Oito testes de regressão com persistência simulada aprovados: criação, localização, convite reutilizado/expirado, falha de cadastro, notificação HTTP, saída das pendências ao salvar condições/contrato, conclusão manual idempotente e paginação.
- Migration validada em PostgreSQL embarcado (PGlite), incluindo backfill e reversão, sem acessar a VPS.

Comandos no backend (Node 22 ou superior):

  NODE_ENV=test node --experimental-test-module-mocks --test tests/regression/partner-invite.mjs
  node --test tests/regression/partner-onboarding-migration.mjs

As correções anteriores de atualização em tempo real, busca por responsável/e-mail e acesso direto à parceria estão preservadas. A aplicação em produção ainda deve ser feita na VPS.
