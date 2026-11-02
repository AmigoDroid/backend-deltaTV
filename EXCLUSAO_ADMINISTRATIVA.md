# Exclusão administrativa — Delta TV

## Exclusiva para superadmin

- `GET /api/v1/admin/partners/:id/deletion-preview`
- `DELETE /api/v1/admin/partners/:id` — body novo: `{"confirmation":"Nome comercial ou slug","deleteClients":false,"deleteDevices":false,"reason":"motivo detalhado"}`. Por compatibilidade a API também aceita `confirmSlug` no lugar de `confirmation` (formato antigo).
- `GET /api/v1/admin/devices/activations/:id/deletion-preview`
- `DELETE /api/v1/admin/devices/activations/:id` — body: `{"confirmMac":"AA:BB:CC:DD:EE:FF","reason":"motivo"}`
- `GET /api/v1/admin/devices/registrations/:id/deletion-preview`
- `DELETE /api/v1/admin/devices/registrations/:id` — body com `confirmMac`.

**Confirmação corrigida:** o modal aceita o nome comercial completo ou o identificador (`slug`) da própria parceria. O motivo continua obrigatório (mínimo 8 caracteres). Erros de banco/API aparecem dentro do modal, sem fechar a janela. Se a exclusão não confirmar, nada deve ser considerado apagado.

**Importante:** Ao excluir uma revenda ou parceiro, o cadastro é **arquivado** (`partners.status='deleted'`), e não fisicamente apagado. Ele não aparece mais na listagem operacional. As contas e códigos são desabilitados; o monitor deixa de sondar os servidores desativados. Isso preserva pagamentos, faturas, saldos, relatórios financeiros e auditoria, que usam chaves estrangeiras restritivas.

As opções do formulário são independentes:

- `deleteClients=true`: apaga permanentemente **fichas** em `reseller_clients` dessa parceria; não apaga cadastros globais `customers`.
- `deleteDevices=true`: apaga todas as ativações vinculadas à parceria, incluindo licenças individuais **pertencentes ao estoque** da revenda, e seus tokens. Apaga apenas os aparelhos físicos que não tenham nenhuma ativação ou acesso Web restante. Outros parceiros compartilhando o MAC são preservados.
- `deleteDevices=false`: preserva o registro de ativações, mas as ativações dependentes da parceria arquivada são negadas na API. **Licenças individuais independentes** podem continuar válidas até a expiração; para apagá-las escolha `deleteDevices=true`.

A exclusão física de uma ativação exige MAC digitado e mantém o aparelho físico. A exclusão física de um dispositivo apaga **todas** as suas ativações, inclusive as de outros parceiros, e elimina sessões/chaves. Nos dois casos os lançamentos financeiros permanecem e têm seu vínculo `activation_id` desassociado se necessário.

## Implantação segura

1. Faça backup verificado do PostgreSQL antes do deploy.
2. Aplique `npm run db:migrate` **antes** de iniciar o backend novo: `20261116000001-superadmin-controlled-deletion.cjs` acrescenta o estado `deleted` e altera a FK de `content_activation_charges.activation_id` para `SET NULL`.
3. Faça `npm run build` do admin, publique-o e reinicie a API pelo PM2.
4. Teste no ambiente de homologação: ativação individual, dispositivo compartilhado, revenda com clientes e cobranças, opção manter vs apagar vínculos, login após exclusão, MAC de acesso Web, auditoria.

**Não homologado em PostgreSQL real** neste ambiente. A migração tem `down` intencionalmente bloqueado por causa de registros financeiros cuja ativação já foi excluída; rollback operacional exige restauração do backup.

Desempenho: os aparelhos associados são removidos por lotes de 500 dentro da mesma transação, com limite de memória dos caches. Apagar dezenas de milhares de ativações ainda pode gerar I/O, WAL e locks significativos; recomenda-se executar em horário de manutenção.
