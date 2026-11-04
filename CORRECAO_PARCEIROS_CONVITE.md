# Correção de parceiros cadastrados por convite

## O que foi encontrado
O cadastro pelo convite já cria a parceria de conteúdo, o usuário do portal e o vínculo do pré-cadastro na mesma transação. Porém, a conclusão usa uma rota pública que não avisava o painel administrativo para atualizar a lista. O bloco de pré-cadastros também não acompanhava atualizações e só mostrava o status, sem acesso às configurações.
A busca procurava apenas nome da empresa e identificador: o nome do responsável e o e-mail do convite não encontravam o cadastro quando a empresa tinha outro nome.

## Alterações
- Conclusão bem-sucedida do convite avisa os administradores para atualizar Parceiros e invalida o resumo do dashboard.
- Convites e lista atualizam ao retornar à aba, na reconexão e periodicamente. Há também botões Atualizar.
- Pré-cadastros concluídos com vínculo mostram Configurar parceria. O botão abre a mesma janela usada no cadastro manual, mesmo quando a parceria está em outra página ou fora do filtro atual.
- Busca permite empresa, identificador, responsável e e-mail.
- Convites já concluídos aproveitam o completedPartnerId que já existe. Não é preciso cadastrar novamente.

## Aplicar na VPS
1. Substitua os arquivos das respectivas pastas backend e admin pelos pacotes corrigidos. Preserve os arquivos .env e a configuração de produção.
2. Reinicie o processo do backend pelo gerenciador usado na VPS (por exemplo, PM2).
3. Na pasta do admin, rode npm ci e npm run build com o .env de produção existente. Publique o dist gerado no diretório servido pelo Nginx.
4. Recarregue o painel com Ctrl+Shift+R para carregar o JavaScript novo.

Esta correção não exige nova migration ou alteração no .env.
Os ZIPs contêm código-fonte. Compile o admin na VPS com sua configuração da API.

## Conferir após aplicar
- Abra Parceiros e clique Atualizar no bloco Pré-cadastro.
- No convite já concluído, clique Configurar parceria: devem abrir as condições, contrato, servidores, códigos e usuário do portal, conforme o cadastro manual.
- Para localizar na tabela, selecione Todos os status, busque pelo e-mail do convite ou pelo nome da empresa informado pelo parceiro e confira a paginação.
- Um novo convite concluído deve atualizar a tabela e o bloco de pré-cadastro sem recarregar a página quando o WebSocket estiver conectado. Sem conexão em tempo real, há atualização periódica e manual.

## Validação local
- Build de produção do admin: passou.
- Quatro testes automatizados: passaram, com persistência simulada e sem banco/SMTP de produção. Cobrem criação e localização por empresa/responsável/e-mail, vínculo para configuração, reutilização, expiração, rollback simulado e notificação da conclusão pela rota HTTP pública.
- Rodar no backend com Node 22 ou superior:
  NODE_ENV=test node --experimental-test-module-mocks --test tests/regression/partner-invite.mjs

Não houve acesso à VPS ou ao PostgreSQL real. Os testes não demonstram o estado atual dos registros de produção. Se o vínculo de um convite já concluído apontar para um cadastro ausente, será necessário investigar esse registro no banco antes de qualquer reparo.
