# Delta TV WebSocket /ws

- Backend Node.js mantém `/ws` no **mesmo servidor HTTP/porta da API**, sem porta adicional. Dependência: `ws` 8.x.
- Navegadores conectam usando WebSocket nativo, enviando token de acesso na primeira mensagem, nunca na URL.
- `Origin` deve constar em `CORS_ORIGINS`; configure as origens completas dos DOIS painéis.
- Acesso separado por papel. Mensagens `changed` não contêm informações privadas; apenas pedem para recarregar os dados via API com autenticação.
- Presença do portal do revendedor é sinalizada aos administradores na conexão/desconexão; a coluna `last_activity_at` é tocada no máximo a cada minuto enquanto conectado. A interface atual consulta o estado persistido, que pode levar até 180s para expirar em desconexão.
- Invalidação do backend é por processo: para PM2 em cluster com múltiplas instâncias, use Redis pub/sub ou adaptador compartilhado antes de habilitar escala horizontal.
- Antes de implantar: `npm install` no backend (para instalar ws), `npm run build` nos dois painéis, migrações do pacote superadmin e suporte ao upgrade WebSocket no Nginx (posteriormente).
- WebSocket é opcional para funcionalidades: caso falhe, operações REST continuam.
- Segurança: no desligamento de sessão o cliente fecha socket. JWT expira e conexão é encerrada; revogações imediatas exigiriam verificação contínua de `tokenVersion` (pode ser adicionada).
