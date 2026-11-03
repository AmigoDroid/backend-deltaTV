No server HTTPS já existente da API:

1. No location / que possui proxy_pass http://127.0.0.1:3000, acrescente:
   proxy_set_header X-Delta-Media-Gateway deltatv-media-v1;

2. Dentro do mesmo server, acrescente:
   include /etc/nginx/snippets/deltatv-media.conf;

3. Copie deltatv-media.conf para /etc/nginx/snippets/ e valide nginx -t.
   Recarregue Nginx antes de ativar NGINX_MEDIA_PROXY=true e reiniciar a API.
   Mantenha o Node no loopback; o marcador não é uma credencial de acesso.
