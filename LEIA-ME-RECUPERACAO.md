# DeltaTV — recuperação do erro `column "sender_user_id" does not exist`

## Motivo

O backend antigo já possui migração `20261212000001-tv-messages.cjs`, que cria `tv_message_campaigns` com `sender_id`, `partner_id` e `payload_hash`, e `tv_message_deliveries` com `campaign_id`, `device_id`, `activation_id`, `read_at`. As rotas correspondentes estão em `src/modules/tv-messages/routes.js` e devem ser montadas como `panelMessages` e `clientMessages`.

O hotfix posterior introduziu uma **implementação incompatível**: `20261217000001-tv-messages.cjs` espera `sender_user_id`, `sender_partner_id`, `request_hash` e novas estruturas de entrega. Com `CREATE TABLE IF NOT EXISTS`, o banco conserva o esquema antigo; a criação do índice novo falha porque `sender_user_id` não existe. A própria API nova também não pode ser usada com a tabela antiga sem mudanças profundas. **Não adicionar colunas às cegas.**

## Procedimento seguro (produção)

1. **Não rode novamente `npm run db:migrate` agora.** Não faça `db:migrate:undo`, `DROP TABLE`, nem manipule `SequelizeMeta` manualmente. Preserve o backup do banco.
2. Faça backup de `src/app.js` e confira o estado da migração anterior:

```bash
cd /var/www/backend-deltaTV
cp src/app.js "src/app.js.backup-$(date +%Y%m%d-%H%M%S)"
npm run db:migrate:status
```

A migração antiga `20261212000001-tv-messages` deve estar `up`. A migração nova `20261217000001-tv-messages` deve estar `down` após a falha. Se esse não for o caso, **pare e investigue o esquema real antes de aplicar**.

3. Envie o ZIP `DeltaTV-tv-messages-recuperacao-segura.zip` para a raiz do backend e extraia. Esse ZIP **não substitui** nenhum arquivo de aplicação; adiciona apenas script, testes e este guia.

```bash
unzip -o DeltaTV-tv-messages-recuperacao-segura.zip
python3 scripts/repair-tv-messages-legacy.py
```

A execução sem parâmetros apenas **mostra diagnóstico e alterações previstas**, sem modificar nada. Se aparecer `Arquivo da implementação original ausente`, não siga: o código no servidor difere do analisado.

4. Após conferir, execute a aplicação do reparo:

```bash
python3 scripts/repair-tv-messages-legacy.py --apply
node --check src/app.js
python3 -m unittest discover -s tests/tv-messages-recovery -v
npm run db:migrate:status
```

O script faz **apenas alterações de arquivos**:
- Retira imports e montagens das rotas novas incompatíveis (`panel.routes.js` e `device.routes.js`).
- Garante `app.use('/api/v1/tv-messages', panelMessages)` e `app.use('/api/v1/client/messages', clientMessages)` com `src/modules/tv-messages/routes.js` existente.
- Move `src/db/migrations/20261217000001-tv-messages.cjs` para `backups/tv-messages-legacy-<timestamp>/`, fora da pasta de migrações, sem deletar nem criar tabelas.
- Cria cópia de `src/app.js` anterior no mesmo diretório de backup.
- Aceita repetição (idempotente). Se `app.js` ou a migração diferirem do previsto, aborta com mensagem de erro.

**Não é necessário rodar `npm run db:migrate` para esta recuperação.** Se `db:migrate:status` mostrar *outras* migrações pendentes, trate-as separadamente, após revisão; não rode todas em produção apenas para sanar mensagens.

5. Se o arquivo já estiver correto e a API estiver ativa, reinicie somente o serviço correto após verificar as rotas:

```bash
pm2 restart DeltaTV-Server --update-env
pm2 logs DeltaTV-Server --lines 60 --nostream
```

No painel logado, confirme que `GET /api/v1/tv-messages?page=1` e `GET /api/v1/tv-messages/recipients?page=1` não retornam 404/500. Sem sessão, pode retornar 401. Com usuário sem permissão, pode retornar 403. **Somente HTTP 200 com sessão autorizada confirma o fluxo.**

Se continuar 404, não rode migrações para tentar consertar: confirme `src/app.js` do processo PM2, se o Nginx está apontando para a instância correta e se o servidor foi reiniciado.

## Limites

- O script **não altera o PostgreSQL** e não resolve automaticamente bugs internos do sistema original de mensagens; ele restaura sua integração de rotas.
- Se houver uma versão personalizada ou migração parcial não equivalente, o script exige revisão manual em vez de arriscar dados.
- A entrega visual das mensagens no aplicativo Roku requer código do aplicativo para consultar/exibir/confirmar. Não foi incluída aqui.
- O script não instala nem atualiza o painel Revenda; cada projeto continua separado.
- Não execute novamente `scripts/install-tv-messages.sh` do hotfix anterior: ele recolocaria a versão incompatível.

## Diagnóstico adicional somente leitura

Para conferir as colunas pelo seu cliente SQL, sem modificar dados:

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'tv_message_campaigns'
ORDER BY ordinal_position;
```

Espera-se encontrar `sender_id`, não `sender_user_id`, no esquema legado. Em caso de diferença, interrompa a instalação e envie o resultado da consulta (sem credenciais).
