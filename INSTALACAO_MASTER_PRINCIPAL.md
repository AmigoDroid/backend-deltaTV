# DeltaTV — emissão própria EXCLUSIVA do Master principal

## O que foi implementado
- Somente Superadmin pode habilitar/desabilitar **Permitir que este Master emita licenças sem comprar** em Admin → Rede de distribuição → selecionar Master principal.
- Master principal = conta com `distribution_role = master`, `parent_partner_id IS NULL`, tipo reseller/both.
- Submaster = conta com `distribution_role = master` mas vinculada a superior. NÃO tem opção nem autorização de emissão.
- Revendas comuns também não têm emissão própria.
- Formulário de emissão somente em Revenda → Licenças → Estoque. Em Minha rede existe apenas atalho.
- A emissão credita estoque tradicional por duração (1 a 120 meses), **não** cria automaticamente uma licença ativa em um dispositivo. O estoque é consumido depois na ativação.
- Idempotência por UUID: repetir uma operação com a mesma chave nunca duplica o lançamento. Histórico e auditoria são transacionais.
- Desativação do Master, ou seu vínculo como Submaster, revoga o privilégio. Se for desvinculado novamente, Superadmin precisará habilitar de novo.
- Configuração desligada por padrão. Limite técnico de 10.000 unidades por solicitação, não uma quota comercial acumulada.

## Arquivos de instalação (HOTFIX / NÃO SUBSTITUIR OUTRAS PASTAS)

### Backend (copiar apenas arquivos do ZIP de backend)
```bash
cd /var/www/backend-deltaTV
# backup completo e pg_dump (em ambiente controlado) antes de migrar
unzip -o DeltaTV-Master-Principal-backend-hotfix.zip
node --check src/modules/distribution/master-issuance.service.js
node --check src/modules/distribution/network.routes.js
node --check src/modules/distribution/network.service.js
node --test tests/unit/master-issuance.test.js
npm run db:migrate:status
npm run db:migrate
npm run db:migrate:status
pm2 restart DeltaTV-Server --update-env
```
Aplicar a migration apenas **depois de backup do banco** e preferencialmente antes em homologação. Não executar `db:migrate:undo` para esta migração, pois é forward-only.

### Admin (copiar apenas o arquivo alterado)
```bash
cd /var/www/painel-admin-DeltaTV
unzip -o DeltaTV-Master-Principal-admin-hotfix.zip
npm run build
```

### Revenda (copiar apenas os arquivos alterados)
```bash
cd /var/www/revenda-DeltaTV
unzip -o DeltaTV-Master-Principal-revenda-hotfix.zip
npm run build
```

Nginx continua servindo as pastas `dist`. Não há necessidade de reiniciar o Nginx se já serve arquivos estáticos.

## Novos endpoints
- `GET /api/v1/admin/network/accounts/:id/self-issuance` (Superadmin)
- `PUT /api/v1/admin/network/accounts/:id/self-issuance` `{ "enabled": true|false }` (Superadmin)
- `GET /api/v1/partner/network/self-issuance` (própria conta)
- `POST /api/v1/partner/network/self-issuance` `{ "months": 12, "quantity": 10, "idempotencyKey": "UUID" }`
- `GET /api/v1/partner/network/self-issuance/requests/:id` (recuperação de tentativa)

## Segurança/limites da validação
- Testes de unidade/política e verificações sintáticas aprovados localmente; sem execução PostgreSQL nem autenticação E2E neste ambiente.
- NÃO atualizar uma VPS de produção sem homologação da migração, login, autorização, saldo, concorrência e revogação.
- Não inclui `.env`, credenciais nem dados da VPS.
