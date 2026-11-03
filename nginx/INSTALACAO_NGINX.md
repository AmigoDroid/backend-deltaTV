# DeltaTV — mídia pelo Nginx

A mudança foi implementada no código e testada localmente. Ela ainda precisa ser instalada na VPS. O pacote preserva as correções anteriores e inclui backend, Admin, configuração interna do Nginx e este guia. Não inclui senhas, `.env` real, banco ou dependências instaladas.

## Funcionamento

O Node autoriza cada nova requisição e processa catálogo e playlists HLS. O Nginx entrega os corpos de vídeo, áudio, legendas, segmentos e chaves, inclusive quando a origem usa HTTP e o acesso público usa HTTPS. As URLs de playlists passam pelo gateway da API. O modo é opcional: `NGINX_MEDIA_PROXY=false` mantém o transporte anterior.

O domínio público precisa ser o da sua API com certificado válido. Esta mudança resolve conteúdo misto para as requisições de reprodução que passam por esse gateway; não corrige codecs incompatíveis, origem indisponível ou URLs externas usadas diretamente por outro frontend.

## Instalação — respeite esta ordem

1. Faça backup dos arquivos da aplicação, do `.env` e da configuração atual do Nginx. Preserve banco, uploads, certificados e chaves de criptografia/JWT.
2. Atualize o código do backend e do Admin com os diretórios deste pacote. Preserve o `.env` real. Não substitua suas credenciais por valores de exemplo. Use Node 22 ou superior e instale as dependências com `npm ci` em cada aplicação.
3. Copie `backend/nginx/deltatv-media.conf` para `/etc/nginx/snippets/deltatv-media.conf` (crie a pasta se necessário). É um trecho de configuração, não um arquivo completo de servidor.
4. No `server` HTTPS existente de `api.deltatv.com.br`, dentro do `location /` que já faz `proxy_pass http://127.0.0.1:3000`, acrescente:

```nginx
proxy_set_header X-Delta-Media-Gateway deltatv-media-v1;
```

Mantenha nesse bloco o encaminhamento de Host e de `X-Forwarded-Proto`. O marcador deve ser definido pelo Nginx, sobrescrevendo o valor recebido do cliente.

5. Dentro do mesmo `server` HTTPS, fora de qualquer `location`, acrescente:

```nginx
include /etc/nginx/snippets/deltatv-media.conf;
```

Mantenha os blocos existentes de TLS, Cloudflare, WebSocket, upload e download. O novo trecho não depende do antigo `/_origin/`. Não exponha a porta 3000 à internet: mantenha o Node no loopback e confirme o firewall. O marcador acima não é uma senha.

6. Verifique se `/etc/ssl/certs/ca-certificates.crt` existe (pacote `ca-certificates` em Debian/Ubuntu). Valide e só então recarregue:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Se a validação falhar, corrija antes de avançar. Não ative a variável abaixo com a configuração incompleta.

7. No `.env` REAL do backend, ajuste somente estas opções, preservando todas as outras:

```dotenv
PUBLIC_BASE_URL=https://api.deltatv.com.br
NGINX_MEDIA_PROXY=true
ACCEL_ORIGIN=0
```

Reinicie o processo da API usando o gerenciador já utilizado na VPS. Não há migração de banco nova para esta mudança. Em seguida, no Admin, execute `npm run build` e publique o conteúdo gerado em `dist` pelo processo habitual.

## Conferência após instalar

Abra novamente o Player Web, faça login e reproduza canal, filme e episódio. No DevTools, confira:

- Requisições de reprodução usam o domínio HTTPS da API.
- Vídeo e segmentos retornam `X-Delta-Media-Transport: nginx`.
- Playlists HLS retornam `X-Delta-Media-Transport: node-playlist`.
- Avançar um filme funciona; se a origem aceita Range, a resposta é HTTP 206.
- Acesso direto a `https://api.deltatv.com.br/_deltatv_media` retorna 404.

Se aparecer `NGINX_MEDIA_NOT_CONFIGURED`/503, confira o marcador no bloco que atende a rota da API. Se aparecer `ORIGIN_REDIRECT_CHANGED`/502, a origem mudou o redirecionamento entre a verificação e a transferência; reabra após alguns segundos. O gateway não envia esse redirecionamento HTTP ao navegador.

## Limites e comportamento operacional

- A banda continua passando pela VPS. A mudança retira a transferência binária do Node; não garante uma redução específica de CPU ou latência.
- O Node verifica a origem antes da transferência, seguindo redirecionamentos com proteção SSRF. Mantém metadados por até 15 segundos; não armazena vídeo nem substitui autorização. Origens que aceitam uma única abertura por URL podem ser incompatíveis com essa verificação. Há fallback para origens que recusam HEAD com 405/501.
- O IP usado na verificação é fixado na conexão do Nginx, com Host/SNI originais e validação de certificado para origens HTTPS. Cookies, cabeçalhos de autenticação do navegador e URLs internas não são encaminhados à origem.
- Revogação é checada nas novas requisições, observados os caches de autorização existentes. Um fluxo contínuo já entregue ao Nginx não tem a checagem periódica do proxy Node; pode continuar até a conexão terminar. Novos segmentos HLS passam novamente pela autorização.
- O contador de streams do Node não conta conexões transferidas ao Nginx. O monitor de tráfego da VPS continua medindo a interface de rede, incluindo esse tráfego. A mudança não cria um contador de espectadores no Nginx. `PROXY_MAX_CONCURRENT` não limita os corpos transferidos ao Nginx.
- Em modo Nginx, acessos Web recebem o espelho HTTPS mesmo que tenham uma preferência antiga de redirecionamento. No Admin, esses modos aparecem como gerenciados pelo gateway.

## Reversão

Defina `NGINX_MEDIA_PROXY=false` e reinicie a API para voltar ao transporte anterior. O trecho interno do Nginx pode continuar instalado. Não remova o trecho enquanto a variável estiver ativa.

## Validação executada

33 testes do backend passaram; 11 testes do Admin passaram e o build foi concluído. O ensaio com Nginx real usou cliente HTTPS e origem HTTP, com 22 verificações de login, catálogo, HLS fragmentado, variantes, áudio, legendas, chaves, segmentos, filmes, episódios, HEAD, Range/206, CORS, redirecionamentos e proteção da rota interna. São testes locais com origem controlada; a fonte real e a configuração da VPS precisam da conferência acima.

Referências: [X-Accel-Redirect e proxy do Nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) e [localizações internas](https://nginx.org/en/docs/http/ngx_http_core_module.html#internal).
