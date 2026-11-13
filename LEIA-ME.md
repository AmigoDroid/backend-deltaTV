# DeltaTV — Refatoração de dados, etapas 1 a 5

## Estado da entrega

Esta entrega contém **cinco migrations Sequelize**, mudanças compatíveis na API e ferramentas de diagnóstico/limpeza. **Não foi aplicada na sua VPS**. Não confirma nem elimina registros duplicados desconhecidos: sem acessar os dados de produção não é seguro fundir clientes, ativar associações ambíguas ou apagar tabelas.

**Base:** `DeltaTV-B63-Backend-migrations-otimizado.zip` (Build 63 com o patch de índices da etapa anterior).

## Etapas realizadas

1. **Identidade:** `20261211000001` acrescenta `reseller_clients.device_id` opcional, apontando para `devices.id`, e índice por empresa/dispositivo. `MAC` continua em todas as rotas legadas. Cadastro sem TV já ativa continua permitido.
2. **Reconciliação:** `20261211000002` vincula somente pares com *mesmo parceiro, MAC idêntico em ativação e dispositivo e exatamente um device_id candidato*. View `v_delta_client_link_issues` mostra contagens para análise, sem nome, telefone ou MAC. Sem matching por nome, IP ou telefone.
3. **Licenças:** `20261211000003` cria duas views de leitura `v_delta_device_current_activation` e `v_delta_device_license_inventory`. A política `evaluateAccess/checkActivation` continua a única decisão autorizadora. Atenção: `v_delta_device_current_activation` mostra apenas a ativação viva mais recente por aparelho **para inventário**, nunca para decidir qual lista pode tocar.
4. **Planos e servidores:** `20261211000004` cria views de estado operacional e contratos sem duplicar URLs, senhas ou regras. `getServicePlan()` agora resolve parceiro, plano atribuído e contrato em uma consulta com JOIN (seguida da leitura do catálogo), em vez de três consultas separadas para o primeiro passo. `mirror/mode.js` continua a fonte das regras proxy/redirect; nenhum balanceamento é alterado.
5. **Retenção:** `20261211000005` cria índices para expiração de `auth_sessions`, `device_sessions` e `device_scoped_sessions`. Limpeza em lotes via script com `--apply --backup-confirmed`; sem essas flags, só informa contagens. Exclui apenas sessões cujo `expires_at` ficou para trás há MAIS de 30 dias. Não apaga licenças, saldos, clientes, listas ou auditoria.

Na API, o cadastro comercial agora salva o `deviceId` quando há vínculo inequívoco, e a listagem pode devolver a identidade canônica no campo adicional `deviceId`. O contrato de JSON antigo permanece intacto.

## Compatibilidade

- Preservadas URLs e endpoints HTTP/WSS antigos, sessão, MAC virtual Roku, licenças e períodos de teste.
- As views e a nova FK são *aditivas*; o app Roku não precisa de atualização.
- Fichas sem TV ativada continuam existindo.
- Clientes de parceiros diferentes jamais são fundidos automaticamente.
- Nenhuma fonte de verdade comercial/financeira é sobrescrita.
- Não há novas tabelas de histórico/telemetria.

## Instalação segura na VPS

**Não substitua seu backend real cegamente se ele tiver mudanças posteriores à Build 63.** Use o PATCH para comparar as modificações.

1. Pare a implantação se houver migrações pendentes desconhecidas; `npm run db:migrate` executa TODAS as pendentes.
2. Faça backup consistente do PostgreSQL e preserve uma cópia recuperável do backend e `.env` **fora da VPS**. Confirme espaço livre antes de construir índices.
3. Extraia `DeltaTV-ETAPAS-1a5-PATCH.zip` numa pasta temporária e copie o conteúdo de `backend/` para a raiz do backend (sem substituir `.env`). Preferir deploy em homologação primeiro.
4. A partir do backend:

```bash
npm run db:migrate:status
npm run db:migrate
npm run db:migrate:status
node --test tests/unit/structural-consolidation.test.cjs
node scripts/db-structure-report.mjs
node scripts/db-reconcile-clients.mjs   # somente leitura, diagnóstico
node scripts/db-expired-sessions.mjs     # somente leitura, diagnóstico
pm2 restart delta-painel
pm2 logs delta-painel --lines 80
```

5. Valide login, parceiros, clientes, cadastro e edição de MAC, troca de listas, licenciamento, suspensão, vencimento, pool de servidores e os três painéis. Execute sondagens do PostgreSQL e acompanhe `CPU`, conexões, latência, WAL e disco.

### Reconciliação posterior (opcional)

A migration 2 faz um backfill seguro de vínculos existentes. Caso novas ativações tornem clientes vinculáveis depois da migração, execute após backup:

```bash
node scripts/db-reconcile-clients.mjs --apply --backup-confirmed
```

O script limita cada execução a 500 vínculos para reduzir a carga no PostgreSQL. Nunca associa casos ambíguos.

### Limpeza de sessões expiradas (opcional)

```bash
node scripts/db-expired-sessions.mjs --apply --backup-confirmed
```

No máximo 500 por tabela em cada execução, com `FOR UPDATE SKIP LOCKED`. Nunca roda sozinho nem é executado por migrations. Um período superior a 30 dias é conservador; revise a política contratual de retenção antes de ativar.

## Rollback

- Faça rollback do código por deploy (conserve os pacotes anteriores). Views e coluna extra podem continuar no banco sem impedir a versão antiga.
- Não rode `db:migrate:undo:all` nem use `db:migrate:undo` sem analisar a migration alvo.
- `down` da etapa 1 **recusa remover a coluna enquanto existirem vínculos**; é intencional. O `down` da etapa 2 remove apenas a view, sem apagar vínculos criados no backfill. Os outros `down` removem views ou índices da respectiva etapa, nunca registros.
- Se tiver ocorrido migração parcial, verifique o status individual e os objetos do PostgreSQL antes de repetir. Retome fora do pico.

## Limites da validação

- Os testes isolados em Node usam interfaces simuladas de migrations; **não são testes integrados com PostgreSQL**.
- Sem acesso à sua VPS, não dá para quantificar duplicatas efetivas, confirmar FK/índices em produção nem garantir redução numérica de CPU.
- Dados comerciais realmente duplicados ou conflitantes precisam ser conciliados com o diagnóstico real; não estão apagados nesta entrega.
