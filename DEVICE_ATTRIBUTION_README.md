# Autoria de ativação e configuração

- `GET /api/v1/admin/devices/registrations/:id/attribution` (perm. `devices:read`) lista, para cada ativação do MAC, a origem da ativação, a última autoria de configuração de lista e a última alteração auditada.
- Os dados vêm de `audit_logs`, não são inferidos a partir do IP ou do dono atual da licença.
- Em ativações anteriores sem auditoria suficiente, a API devolve `null` e o painel informa que não há autoria identificada.
- Configurações realizadas por link público aparecem como `Link público / anônimo`, e abertura pelo aparelho como `Próprio dispositivo`.
- O nome é resolvido pelo usuário atual quando existe; se o usuário tiver sido apagado, usa o nome salvo em `audit_logs.metadata.actorName`.
- **O superadmin pode editar configurações de uma ativação revogada** sem reativar a licença, e editar lista própria também em uma ativação de parceria. Nenhuma operação ignora unicidade, criptografia, SSRF ou regras de integridade.
- Para atribuição humana exata em cadastros públicos e para todas as operações antigas, seriam necessários registros de identificação que podem não existir. O sistema não inventa essas pessoas.
