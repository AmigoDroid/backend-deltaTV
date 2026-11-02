# Correção de IP real do cliente no login — Delta TV

## Causa

`src/modules/auth/auth.routes.js` já registra `req.ip` no histórico de login. O endereço `127.0.0.1` é o socket Nginx → Node.js quando `TRUST_PROXY=0`. Também afeta auditoria e os rate limits por IP.

## 1. Ajuste obrigatório na VPS

No `.env` efetivamente carregado pelo PM2 (geralmente `/var/www/backend-deltaTV/.env`, mas confira), defina:

```env
NODE_ENV=production
API_BIND_HOST=127.0.0.1
TRUST_PROXY=loopback
```

**Importante:** se já existe `TRUST_PROXY=0` no `.env`, ele sobrescreve o padrão seguro do novo código. Troque por `loopback`.

O código agora carrega o `.env` antes de avaliar `NODE_ENV`, e assume `loopback` somente quando `NODE_ENV=production`, o Node está vinculado a localhost e `TRUST_PROXY` está ausente. Uma configuração explícita tem precedência. O startup mostra o valor efetivo e avisa quando configurado como 0. Não use `TRUST_PROXY=true`.

## 2. Nginx: defina o IP enviado pela borda de confiança

Dentro do `server` HTTPS de `api.deltatv.com.br`, em `location /` (e nas demais locations que usam `proxy_pass` para o Node), mantenha:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
```

Usar **`$remote_addr` no lugar de `$proxy_add_x_forwarded_for`** evita herdar endereços enviados arbitrariamente pelo cliente. Não substitua outros blocos de proxy nem o bloco `/ws`; revise a origem dos cabeçalhos em cada location.

## 3. Se a API estiver com o proxy laranja da Cloudflare ativado

O Nginx verá o IP da Cloudflare até configurar o módulo `ngx_http_realip_module` com `real_ip_header CF-Connecting-IP` e `set_real_ip_from` **somente para as faixas de IP oficiais da Cloudflare**. Consulte https://www.cloudflare.com/ips-v4 e https://www.cloudflare.com/ips-v6 para manter as faixas atualizadas. Nunca use `set_real_ip_from 0.0.0.0/0`, porque qualquer origem poderia forjar um IP.

Após configurar o realip corretamente, `$remote_addr` passa a ser o IP real fornecido pela Cloudflare. Se o DNS da API estiver com proxy desativado, não há esta etapa adicional.

## 4. Aplicação e verificação

```bash
sudo nginx -t && sudo systemctl reload nginx
cd /var/www/backend-deltaTV
pm2 restart DeltaTV-Server --update-env
pm2 logs DeltaTV-Server --lines 30
```

Para confirmar a configuração efetiva **sem mostrar chaves**, execute:

```bash
node --input-type=module -e "import('./src/config/env.js').then(({env}) => console.log({nodeEnv:env.nodeEnv,bindHost:env.bindHost,trustProxy:env.trustProxy}))"
```

Em uma nova sessão do navegador, faça login e veja o histórico. Um registro **antigo** com `127.0.0.1` não será alterado automaticamente.

Se voltar a mostrar um endereço da Cloudflare em vez do usuário, falta a configuração Cloudflare realip do item 3.

**Segurança:** `req.ip` só é confiável se a aplicação aceitar conexões somente via Nginx e o Nginx sanitizar os cabeçalhos. Não use `req.headers['x-forwarded-for']` diretamente no backend. O IP e a localização aproximada não identificam de forma exclusiva uma pessoa ou aparelho.
