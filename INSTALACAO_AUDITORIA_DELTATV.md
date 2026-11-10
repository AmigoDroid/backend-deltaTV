# DeltaTV — auditoria de conexão por dispositivo

Implementação de 10/11/2026. Backend, admin, parceiro, revenda e Roku build 46.
Os arquivos foram preparados e testados localmente; não houve alteração na VPS nem instalação na TV.

## O que aparece em “Conexão / URL”

- URL base escolhida pelo resolvedor ao entregar a configuração da lista.
- Origem efetivamente observada pelo proxy, inclusive domínio/porta após redirecionamentos da origem.
- Estado informado pelo player: abrindo, reproduzindo, carregando, pausado, erro, concluído ou parado.
- Horário, código HTTP, código de erro do player/transporte, posição do vídeo e build.
- Família IP do acesso à API e da conexão com a origem, quando observadas. O IP do cliente depende da configuração correta de TRUST_PROXY; com Cloudflare ou outro intermediário, a API não observa necessariamente o enlace físico da TV.
- Tempo até a resposta da origem, incluindo resolução e tentativas internas. Não é um teste de velocidade nem uma medição de banda.
- Histórico por ativação/lista: não mistura listas de outros parceiros no mesmo MAC.

O painel apresenta quatro evidências separadas. A última seleção de catálogo pode diferir da origem de uma mídia que já estava aberta. O estado “reproduzindo” é informado pela TV, não inferido de uma resposta HTTP 200/206.

A URL exibida contém protocolo, domínio e porta. Usuário, senha, caminho de mídia e query string não são armazenados na auditoria. O histórico não armazena títulos dos conteúdos.

## Onde acessar

- Superadmin/admin autorizado: Dispositivos → ficha do MAC → lista/vínculo → **Conexão / URL**.
- Parceiro: Dispositivos → **Conexão / URL** na ativação.
- Revenda: Dispositivos → listas do MAC → **Conexão / URL** na lista.

O backend exige autenticação. O admin precisa da permissão `devices:read`; parceiros só consultam ativações da própria parceria ou cuja licença pertence à revenda. O cadastro de um MAC, sozinho, não concede acesso à auditoria. Uma lista de outro parceiro pode ser apresentada na consulta de MAC, mas sua auditoria é negada se não houver vínculo autorizado. O histórico anterior não é entregue a uma nova revenda após transferência da licença.

## Instalação — ordem necessária

1. Faça backup do código em produção e do PostgreSQL. Preserve o `.env` e os diretórios de arquivos enviados pelos usuários.
2. Atualize os arquivos do **backend** com o pacote correspondente. Na pasta do backend, execute:

   ```bash
   npm ci --include=dev
   npm run db:migrate
   pm2 restart delta-painel --update-env
   pm2 logs delta-painel --lines 60
   ```

   `--include=dev` mantém disponível o `sequelize-cli`, usado pelas migrations. A migration nova é `20261204000001-device-connection-audit.cjs`; cria duas tabelas e índices. Não use `sequelize.sync()` e não apague o banco.

3. Publique a pasta `dist` do pacote **admin** no site do admin, a `dist` do **parceiro** no site do parceiro e a `dist` da **revenda** no site da revenda. As três compilações incluídas apontam para `https://api.deltatv.com.br`. Para outro endereço, recompile usando `VITE_API_URL`.
4. Instale o ZIP **DeltaTV-build-46-auditoria-conexao.zip** na Roku e reabra o aplicativo. O ZIP contém `manifest` na raiz, sem pasta externa.
5. Abra a lista e reproduza um canal, filme ou episódio. Aguarde alguns segundos e consulte **Conexão / URL**.

Não há novas variáveis de ambiente obrigatórias. Esta atualização preserva os modos proxy/redirect e a proteção IPv6 anteriores. O endereço do servidor já usado pelo app Roku foi preservado; a publicação do backend precisa atender esse endereço também.

## Comportamento e limites

- A Roku envia eventos em Task, fora da thread da interface, com timeout de 5 s, fila máxima de oito estados e sinal periódico de 30 s durante a reprodução. Eventos pendentes há mais de 10 s são descartados para não reaparecerem como atuais.
- O token de auditoria é emitido ao carregar a configuração Xtream. Ele só autentica a telemetria, está vinculado à ativação/sessão e não substitui tokens de reprodução ou renovação. A revogação e a expiração da sessão são verificadas a cada envio.
- O diagnóstico completo do player requer a nova build e a configuração Xtream obtida do backend atualizado. Builds antigas e outros players continuam funcionando: suas conexões via proxy podem gerar eventos do servidor, mas não informam os novos estados do player.
- O painel atualiza a cada 15 s enquanto estiver visível. Após 90 s sem sinal válido, mostra “Sem confirmação recente da TV”. Isso não prova, isoladamente, falha na origem: pode ser TV desligada, app fechado ou rede indisponível.
- Se a TV perde totalmente a conexão com a API, não consegue transmitir o erro naquele instante. Não há reconstrução retroativa desses eventos após uma queda longa.
- No modo **redirect direto**, o backend registra a seleção e o redirecionamento que enviou. Não consegue observar redirecionamentos posteriores, segmentos ou falhas de rede entre a TV e o provedor.
- No modo **proxy Node**, o backend registra a resposta/erro da origem e a URL final observada. Segmentos HLS repetidos são amostrados a cada 30 s; mudanças de resultado ou origem são registradas.
- No modo **Nginx**, “Entrega encaminhada ao Nginx” confirma a resolução/encaminhamento. Não confirma a conclusão do download ou a decodificação na TV. A reprodução é informada separadamente pelo player.
- Falhas ao gravar a auditoria do proxy não interrompem o vídeo. O backend registra um aviso resumido, limitado a um por minuto. A coleta é limitada a 100 gravações pendentes por processo; sob sobrecarga pode haver lacunas.

## Banco e retenção

`device_connection_latest` mantém até três estados por ativação: TV, servidor e seleção. `device_connection_events` guarda mudanças e amostras a cada cinco minutos quando o estado permanece igual. Heartbeats atualizam o estado atual sem criar uma linha histórica a cada 30 s.

A consulta mostra os últimos sete dias. A limpeza física é incremental, até 1.000 eventos antigos por minuto por processo com atividade; em períodos sem atividade ou com muito volume, a remoção pode atrasar. Monitore disco e quantidade de eventos ao crescer a base. A exclusão definitiva da ativação remove os registros por cascade.

## Validação realizada

- 13 testes automatizados aprovados: migração/reversão em PostgreSQL embarcado PGlite, persistência, amostragem, permissões, transferência de licença, estado antigo, sessão revogada/expirada, separação dos tipos de token, remoção de credenciais da URL, cascata, conexão com origem redirecionada, HTTP 206/503 e regressões do proxy IPv6/HLS/Range.
- Compilação de produção dos três painéis aprovada.
- Validação estática BrightScript/SceneGraph da build 46 aprovada; função de limpeza de URL executada em intérprete BRS com IPv4/domínio e IPv6.
- Aplicação Express carregada com as novas rotas.

Comandos de teste do backend:

```bash
npm run test:connection-audit
npm run test:ipv6
```

Não foi possível executar validação visual em navegador neste ambiente, nem repetir o teste com um processo Nginx real. Os testes de transporte HTTP e do caminho de fallback foram executados. A validação final na Roku física e na VPS ainda é necessária.

## Roteiro de aceite na sua TV

1. Abrir ao vivo, filme e série: confirmar estado informado e endereço solicitado pela TV.
2. Pausar/retomar um filme: verificar estados e posição; sair: verificar “Parado” ou, se o fechamento impedir o envio, o vencimento do último sinal.
3. Selecionar outro servidor de teste ou simular indisponibilidade de um servidor da parceria: renovar a configuração e comparar URL selecionada, base usada e origem final. A auditoria não muda a política de failover existente e não migra automaticamente um vídeo já aberto.
4. Em uma origem de teste, provocar HTTP 404/503: conferir a origem e o erro; depois restaurar e confirmar a recuperação.
5. Cortar a rede da TV: após 90 s, o painel deve mostrar ausência de confirmação recente, sem afirmar que o provedor caiu.
6. Entrar em outra revenda/parceria: confirmar que não acessa a auditoria desse vínculo.
7. Em dispositivo que realmente suporte IPv6, reproduzir com IPv4 indisponível no cliente e origem IPv4 acessível pela VPS. A auditoria não adiciona suporte IPv6 ao sistema operacional da TV.
