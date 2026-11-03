# Delta TV — Convite público do parceiro, versão por rota

## Novo fluxo

1. Superadmin pré-cadastra nome e e-mail e marca **Enviar e-mail** (ou reenvia convite).
2. O backend cria token aleatório e envia `https://parceiro.deltatv.com.br/convite/TOKEN`.
3. Ao abrir a URL, o Nginx deve devolver o `index.html` do SPA.
4. O `index.html` recolhe o token antes de iniciar o React e remove-o da barra do navegador.
5. O portal entra no fluxo público, **mesmo com sessão autenticada**, sem montar o painel/WebSocket.
6. O frontend faz `POST /api/v1/auth/partner-invite/verify` com `{ "token": "..." }` no corpo JSON.
7. **Somente se a API retornar dados válidos** aparece o formulário com nome/e-mail do convite e campos para empresa, senha e confirmação.
8. Conclusão: `POST /api/v1/auth/partner-invite/complete`. A API continua garantindo token de uso único e prazo de 72 horas.
9. Convites inválidos, usados, cancelados ou expirados exibem explicação clara, **não** redirecionam silenciosamente ao login. Falha temporária da API permite tentar novamente.

Links antigos `?convite=TOKEN` e `#convite=TOKEN` continuam aceitos no frontend.

## Arquivos alterados

Backend: `src/modules/partners/partner-invite.policy.js` (formato da URL do e-mail) + teste unitário.

Parceiro: `index.html`, `src/invite-link.js`, `src/App.jsx`, `src/InviteRegistration.jsx`, `src/invite.css` + testes locais.

**Não altera migrations, banco, SMTP, contas, créditos, Player Web, Nginx da API ou proxy de vídeo.**

## Publicação segura (VPS)

Exemplo para o **patch** (adapte a pasta do portal à sua instalação):

```bash
mkdir -p /tmp/delta-convite
unzip -o /home/deploy/deltatv_patch_convite_rota_publica.zip -d /tmp/delta-convite

# Faça backup do código atualmente instalado antes de copiar.
cd /var/www/backend-deltaTV
cp src/modules/partners/partner-invite.policy.js /home/deploy/partner-invite.policy.js.bak
cp /tmp/delta-convite/backend/src/modules/partners/partner-invite.policy.js src/modules/partners/partner-invite.policy.js
node --check src/modules/partners/partner-invite.policy.js
pm2 restart DeltaTV-Server --update-env
```

No projeto do **painel do parceiro** (use a pasta correta do projeto fonte, não a pasta `dist`):

```bash
cd /CAMINHO/DO/PROJETO/PARCEIRO
# Faça um backup dos arquivos modificados.
cp /tmp/delta-convite/partner/index.html index.html
cp /tmp/delta-convite/partner/src/App.jsx src/App.jsx
cp /tmp/delta-convite/partner/src/InviteRegistration.jsx src/InviteRegistration.jsx
cp /tmp/delta-convite/partner/src/invite-link.js src/invite-link.js
cp /tmp/delta-convite/partner/src/invite.css src/invite.css
npm ci
npm run build
```

O Nginx precisa servir o **`dist` recém-compilado** do portal. Se o `dist` é gerado diretamente na pasta usada pelo Nginx, basta recarregar a página (sem trocar arquivos do backend por conta do site). Se seu fluxo copia o `dist` para outra pasta, publique os arquivos no destino atual e limpe cache do navegador/CDN.

### Nginx — suporte ao caminho `/convite/TOKEN`

Confira o `server` de `parceiro.deltatv.com.br`. Para sites Vite/React SPA, **normalmente já existe**:

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

Se não houver fallback, corrija dentro do `server` **do portal do parceiro**, nunca na API. Alternativamente, use a localização específica:

```nginx
location ^~ /convite/ {
    try_files /index.html =404;
    add_header Cache-Control "no-store" always;
    add_header Referrer-Policy "no-referrer" always;
    access_log off;
}
```

Se existir uma rota `/convite` sem barra, adicione `location = /convite { try_files /index.html =404; }`, ou mantenha o fallback geral do SPA. A recomendação `access_log off` reduz a exposição de tokens nos logs dessa rota; o serviço de e-mail, proxies e CDN ainda podem ter registros do clique. Tokens são credenciais sensíveis — use HTTPS, não compartilhe links reais e, se possível, desative rastreamento de cliques para mensagens de convite.

Valide antes de recarregar o Nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -I https://parceiro.deltatv.com.br/convite/TESTE
```

O `curl` deve receber o HTML do portal (tipicamente HTTP 200), não 404. Em seguida, copie manualmente a URL `https://parceiro.deltatv.com.br/convite/TESTE` no Chrome: deverá aparecer **convite inválido** em vez do login. Um token real deve mostrar **Verificando convite** seguido de **Conclua seu cadastro** quando a API o validar.

## Importante sobre convites antigos

Depois de publicar **backend e frontend**, use **Reenviar convite** no Admin e clique no link novo. Os links anteriores continuam compatíveis se o token não foi revogado e se não foi corrompido pelos redirecionadores do provedor de e-mail. Reenviar gera um token novo e invalida o anterior.

## Testes locais executados na preparação

- 15 testes JavaScript de rota, captura do token, compatibilidade e fluxo de validação.
- 5 testes da política de token e geração do link no backend.
- 161 arquivos JS/JSX analisados sem erros sintáticos.
- Build Vite integrado não executado neste ambiente devido a dependência fora do cache npm (`yallist`). Compile na VPS com `npm ci && npm run build`.
- Validação de SMTP, PostgreSQL e rota real no domínio precisa ser feita após o deploy.
