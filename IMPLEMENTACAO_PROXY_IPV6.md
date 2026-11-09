# DeltaTV — proxy completo e IPv6 — 09/11/2026

## O que foi entregue

- PROXY_ALL_DELIVERY=true força catálogo, autenticação Xtream, EPG e mídia pelo servidor em todas as ativações, inclusive TVs, listas próprias e Player Web. Tem prioridade sobre redirect e overrides por tipo. A autenticação Delta e as verificações de licença continuam obrigatórias.
- O modo global é opt-in para não transferir inesperadamente toda a banda de produção à VPS. Pode ser usado com Node ou Nginx.
- No admin, escolher/reaplicar um modo único remove exceções antigas por tipo. O painel identifica a proteção global. Essa mudança não depende de migration.
- HLS: MIME application/audio/video, variantes, segmentos, chaves e mapas. Playlists parciais com MIME HLS são buscadas novamente sem Range. VOD mantém Range e resposta 206.
- M3U: endereços HTTP de mídia fora do padrão Xtream são encapsulados quando os três tipos de mídia estão em proxy. Logos, capas e demais metadados externos não são retransmitidos por esta atualização.
- Nginx: IP da origem validado e fixado, Host/SNI preservados. Se o GET real redirecionar, usa novamente a rota autenticada pelo Node, que segue e valida os saltos sem expor Location ao cliente.
- Roku build 44: invalida configuração antiga em cache e faz até duas reconexões ao gateway, espaçadas em 1,5 segundo. VOD usa a posição validada já existente. Não converte sessões diretas em proxy automaticamente: ative o proxy no servidor antes do teste.
- Correção de nome de variável TMDB que conflitava com a função Txt; template white-label sincronizado nos arquivos modificados.

## Instalação

1. Faça backup do backend, admin e configuração Nginx atuais. Preserve o .env real; o .env.example é apenas referência.
2. Atualize o backend e execute npm ci --omit=dev. Use Node >=22. Não há migration nova nesta atualização.
3. Para validar primeiro apenas o Node, configure:

```dotenv
PUBLIC_BASE_URL=https://api.deltatv.com.br
API_BIND_HOST=127.0.0.1
TRUST_PROXY=loopback
PROXY_ALL_DELIVERY=true
NGINX_MEDIA_PROXY=false
ACCEL_ORIGIN=0
```

4. Reinicie o processo real do backend usando PM2 com --update-env. O nome do processo deve ser o que existe na VPS.
5. Para usar Nginx como motor de mídia, copie nginx/deltatv-media.conf para /etc/nginx/snippets/deltatv-media.conf e inclua-o DENTRO do server HTTPS da API. Adapte o location / existente com nginx/api-location.example.conf; não duplique locations nem sobrescreva certificados, /ws, regras Cloudflare ou outros serviços. Ajuste 127.0.0.1:3000 se o backend usa outra porta.
6. Garanta listen [::]:443 ssl no server, DNS AAAA, certificado válido e entrada TCP 443 IPv6. Se houver CDN na frente, valide também a conexão do cliente até a CDN e o caminho até a VPS.
7. Execute sudo nginx -t e só então recarregue o Nginx. Depois ative NGINX_MEDIA_PROXY=true e reinicie o backend. O marcador X-Delta-Media-Gateway deve estar no proxy da API. A porta Node deve permanecer local.
8. Publique admin/dist no caminho do painel, preservando a configuração do site. O pacote também contém o código-fonte.
9. Instale o ZIP Roku build 44 pelo fluxo habitual. Encerre e reabra o aplicativo para obter a configuração do servidor. Atualizações de transporte não alteram URLs já abertas por uma reprodução em andamento.

## Teste na rede real

Use um computador IPv6-capaz e depois o dispositivo-alvo. Desligar IPv4 só no computador não testa a TV.

- Confirme acesso IPv6 ao domínio da API: curl -6 -I https://api.deltatv.com.br/ . Uma resposta HTTP, mesmo 404, comprova apenas conexão HTTP/TLS, não autenticação ou reprodução.
- Faça login, abra catálogo, reproduza canal HLS e TS, filme e episódio. Avance e retome VOD.
- Confira que requisições de mídia protegidas ficam no domínio Delta; não pode haver Location externo para o IPTV.
- Mantenha a origem acessível somente por IPv4 para validar a ponte. A VPS precisa continuar alcançando essa origem.
- Interrompa IPv4 do cliente durante a reprodução e observe a recuperação. A conexão TCP existente não muda de família IP: é necessário reconectar. A escolha IPv6 depende do sistema/player.
- Verifique chaves/segmentos HLS e URLs que redirecionam, não apenas a playlist inicial.
- Teste também bloqueio da licença, troca de canal e limite de conexões do provedor.

## Limites importantes

O suporte IPv6 do SDK Roku depende do modelo e sistema. A resposta técnica oficial de julho/2026 informa limitação em roUrlTransfer; esta build não remove limitações do firmware. Testes locais de servidor não equivalem a teste numa TV física.
https://forum.developer.roku.com/t/cant-get-ipv6-requests-to-work/11499

Não implementado: alternância automática direto → proxy conforme falha da rede do cliente, diagnóstico automático de família IP na TV, proxy de capas/logos, transcodificação ou garantia de troca sem pausa. O modo completo evita depender da origem diretamente desde o início.

O fluxo Nginx existente descarrega a mídia antes dos contadores e revalidações periódicas do relay Node. PROXY_MAX_CONCURRENT e recheck de 30 s do Node não devem ser usados como limite/corte garantido de streams longos descarregados no Nginx. Novas requisições passam pela autorização; HLS reautoriza os segmentos. Para controle periódico Node use NGINX_MEDIA_PROXY=false. Dimensione banda e conexões no Nginx antes de habilitar globalmente.

Cada espectador a 8 Mb/s acrescenta aproximadamente 8 Mb/s de entrada e 8 Mb/s de saída na VPS. O probe HEAD/GET usado pelo Nginx também pode consumir uma conexão temporária no provedor.

Rollback: restaure arquivos/configurações anteriores ou desative PROXY_ALL_DELIVERY, reponha os modos desejados e reinicie o backend. O app precisa atualizar sua configuração; pode ser necessário reabrir o conteúdo. Não substitua credenciais por valores do exemplo.

## Validações

- Suite tests/ipv6/proxy.test.js: proteção de modos, compatibilidade do redirect, MIME HLS, URLs HLS/M3U, conexão IPv6 loopback para origem IPv4, redirect seguido no servidor e Range/206.
- 9 testes da suite de proxy aprovados (npm run test:ipv6).
- Nginx 1.24: nginx -t e teste HTTP real IPv6 → Nginx → origem IPv4 aprovados; Range/206 e fallback por redirect verificados. Teste local, sem validar o TLS/DNS de produção.
- npm run build no admin.
- Validação estática BrightScript/XML com BrighterScript.
- Sintaxe JavaScript do backend.
- Sem teste na VPS de produção, banco de produção ou TV física.
