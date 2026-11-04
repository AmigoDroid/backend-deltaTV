# PlayerWeb — HTTPS automático nas URLs do parceiro

## Onde configurar
No painel admin: Player Web → menu do código → Entrega → Usar HTTPS automaticamente nas URLs do parceiro → Salvar.
A opção também aparece em Novo acesso web ao informar o código do parceiro ou copiar uma lista da TV.
A configuração é individual por acesso web e controlada pelo administrador. A revenda pode consultar o valor, sem alterá-lo.

## Comportamento
- Ativada por padrão para acessos novos e existentes após a migration.
- O servidor seleciona o provedor associado ao código e aplica HTTPS ao endereço escolhido, inclusive em alternativas selecionadas pelo mecanismo de failover já existente.
- HTTP vira HTTPS; endereços que já usam HTTPS são mantidos.
- O endereço cadastrado do parceiro fica preservado. A política vale apenas para o PlayerWeb com lista de parceria; TVs e links próprios ficam com seu comportamento atual.
- A verificação inicial do usuário/senha, o catálogo Xtream, a origem da playlist e as URLs de reprodução usam a base ajustada.
- Segmentos HLS absolutos em HTTP no mesmo host do parceiro também são ajustados; CDNs em outros hosts continuam sob o proxy existente.
- Ao desativar, o acesso volta a usar o protocolo cadastrado. O cache de autorização do espelho é invalidado ao salvar. Reabra o catálogo/reprodução para carregar novas URLs.
- As escolhas existentes de proxy/redirect e a cobrança/licença são mantidas.

Exemplos:
  http://provedor.example → https://provedor.example
  https://provedor.example → https://provedor.example
  http://provedor.example:8080 → https://provedor.example:8080
  HTTP na porta padrão 80 passa para HTTPS na porta padrão 443.

HTTPS precisa estar disponível no servidor e na porta escolhida, com certificado válido. Alterar o protocolo não instala TLS nem descobre outra porta HTTPS. Se o parceiro só atender HTTP, desative esta opção nesse acesso e configure a entrega pelo proxy existente conforme necessário. As regras de CORS do parceiro continuam valendo quando o navegador acessa a origem diretamente.

## Aplicar
1. Preserve os .env de produção e substitua o código pelos ZIPs atualizados.
2. Na pasta backend, rode npm run db:migrate antes de reiniciar a aplicação. A nova migration é 20261123000001-playerweb-auto-https.cjs e adiciona activations.web_auto_https. Ela habilita a opção nos acessos existentes também.
3. Reinicie o processo do backend. Caso use modo watch, pare o processo durante a substituição/migration.
4. Na pasta admin, rode npm ci e npm run build com o .env de produção atual e publique o dist gerado no diretório servido pelo Nginx.
5. Recarregue o painel com Ctrl+Shift+R.
Não é necessário alterar variáveis de ambiente.

As melhorias anteriores da tela de Parceiros estão incluídas, com suas migrations. npm run db:migrate aplica as pendências na ordem correta.

## Verificação local
Build de produção do admin aprovado. Nove testes anteriores de parceiros e doze verificações novas de HTTPS passaram (21 no total). Os testes cobrem conversão, portas, desativação persistida, preservação das TVs/listas próprias, verificação inicial, API/EPG/mídia, HLS, seleção de alternativas, permissões do admin, invalidação de cache e migrations.
Os testes de fluxo usam dependências/banco simulados; as migrations foram exercitadas em PostgreSQL embarcado (PGlite). Os testes não acessaram provedores reais, frontend do cliente, VPS ou banco de produção.

Rodar no backend:
  NODE_ENV=test node --experimental-test-module-mocks --test --test-concurrency=1 tests/regression/*.mjs
