# DeltaTV — Gerenciamento de exclusão operacional de códigos e servidores
**Patch:** `DELTA-DELETE-20261115-01` · **Data:** 15/11/2026

## Escopo e regras
- **Superadmin:** pode remover operacionalmente códigos e servidores de qualquer parceria por `/api/v1/admin/partners/:id/...`; nenhum papel `admin` comum recebe essa autorização.
- **Revenda / Master / Submaster:** pode remover somente códigos e servidores da própria conta autenticada por `/api/v1/partner/...`. O escopo vem do JWT, não do ID enviado no corpo.
- **Parceiro de conteúdo:** pode remover somente códigos e servidores da própria conta autenticada por `/api/v1/content-partner/...`.
- **Código:** operação `DELETE` autentica, exige confirmação digitada, revoga o uso, marca `deleted_at`, remove pools do código e grava auditoria. **Não apaga licenças, ativações, créditos ou lançamentos financeiros.** Códigos excluídos não voltam a ficar disponíveis para outro parceiro: o código textual continua reservado globalmente por segurança.
- **Servidor:** prévia de impacto, substituto opcional do mesmo parceiro, migração dos vínculos do servidor para o substituto quando escolhido, desativação e marcação `deleted_at`. Para excluir um servidor com TVs vigentes sem substituto, é preciso marcar consentimento expresso do risco de interrupção. Transação e auditoria.
- **Histórico:** exclusão é **operacional (arquivamento)**, não `DROP` físico. Isso é necessário para manter FKs RESTRICT de cobrança, auditoria e licenças. Arquivamento não altera saldos comerciais nem transfere créditos do código excluído; créditos existentes ficam preservados, mas inacessíveis para novas operações até uma recuperação administrativa.
- Não se trata de exclusão de dispositivos, licenças, pagamentos ou contas. As funções existentes desses domínios foram preservadas.

## **ALERTA: migração conflitante de mensagens para TVs**
Em 15/11/2026, a VPS apresentou `down 20261217000001-tv-messages.cjs` e `ERROR: column "sender_user_id" does not exist`. Se isso ainda ocorrer, **NÃO execute** `npm run db:migrate`: corrigir a migração antiga conforme o reparo de mensagens entregue antes. O pré-verificador abaixo bloqueia a migração enquanto houver outra `down` não revisada.

## Instalação segura (por painel independente)
**1. Faça backup completo do PostgreSQL e de cada pasta de produção. Homologue em cópia da VPS primeiro.**

**2. Backend:** extrair `DeltaTV-exclusao-backend-hotfix.zip` **na raiz** da pasta `/var/www/backend-deltaTV`:

```bash
cd /var/www/backend-deltaTV
unzip -o DeltaTV-exclusao-backend-hotfix.zip
node --check src/modules/providers/operational-deletion.service.js
node --test tests/unit/operational-deletion.test.js
bash scripts/check-deletion-migrations.sh
# somente se o pré-verificador aprovar e depois do backup do banco:
npm run db:migrate
npm run db:migrate:status
pm2 restart DeltaTV-Server --update-env
pm2 logs DeltaTV-Server --lines 80 --nostream
```

**3. Superadmin:** extrair `DeltaTV-exclusao-admin-hotfix.zip` na raiz de `/var/www/painel-admin-DeltaTV` e executar `npm test && npm run build`.

**4. Revenda:** extrair `DeltaTV-exclusao-revenda-hotfix.zip` na raiz de `/var/www/revenda-DeltaTV` e executar `npm test && npm run build`.

**5. Parceiro:** extrair `DeltaTV-exclusao-parceiro-hotfix.zip` na raiz de `/var/www/painel_parceiro` e executar `npm run build` (este pacote apenas troca `App.jsx` e adiciona o componente de exclusão; o PWA/favicons instalados anteriormente ficam preservados).

Não copie a pasta `packages/` nem unifique diretórios entre painéis.

## Testes manuais obrigatórios em homologação
1. Como **Revenda**, exclua um código sem ativações e confirme que some da lista. Tente excluir um código de outra parceria por ID: espera-se HTTP 404.
2. Como **Parceiro de conteúdo**, exclua um código com créditos; confira o aviso, auditoria e preservação dos lançamentos. O código deve desaparecer das listas, mas seus créditos não são automaticamente transferidos a outro código.
3. Exclua um servidor sem vínculo. Recrie a mesma URL na conta: deve ser permitido (índice único parcial).
4. Exclua um servidor em pool; confira que os vínculos do pool não bloqueiam a operação e que código continua apontando para servidor ativo.
5. Exclua um servidor com TV vinculada **escolhendo substituto**: confirme que a ativação passa a referenciar o novo servidor e teste reprodução real com credenciais válidas.
6. Com TV em uso e sem substituto, a interface deve exigir consentimento de que o conteúdo pode deixar de funcionar.
7. Como Superadmin, repita em uma parceria qualquer; como `admin` comum, o endpoint de exclusão deve retornar HTTP 403.
8. Teste busca e listagem, código duplicado, monitoramento de servidores e atualização dos dados após exclusão.

## Diagnóstico
A interface inclui `DELTA-DELETE-20261115-01`; na VPS use:
```
grep -R -l 'DELTA-DELETE-20261115-01' dist/assets | head
```
Se não houver resultado após `npm run build`, o pacote certo não foi compilado. Se houver no `dist` mas não no navegador, verifique `root` do Nginx e cache do navegador/CDN.

## Limitações
- Não foi possível validar as transações num PostgreSQL real nem executar `npm run build` (dependências de produção não disponíveis neste ambiente). **Não liberar em produção sem homologação**.
- A migração é aditiva, mas altera o índice de unicidade das URLs. Deve ser executada numa janela controlada, pois adquire bloqueios breves na tabela.
- Excluir servidor em uso pode interromper TV se não existir substituto compatível. Mesmo com substituto, as credenciais Xtream precisam funcionar nesse destino.
- Não foi criada nesta entrega uma lixeira visual para restaurar códigos/servidores. O histórico permanece preservado, mas restaurar dados arquivados exige procedimento administrativo posterior.
