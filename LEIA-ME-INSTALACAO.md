# DeltaTV — correção das listas móveis e migração controlada de dispositivos legados

Data da entrega: 2026-11-15. Projetos **independentes**: Admin, Revenda e Backend.

## O que esta entrega faz

### Revenda
- Diminui reconsultas de listas quando chegam eventos WebSocket sem relação com a tela aberta.
- Impede que polling em segundo plano sobreponha buscas em andamento; preserva resultados visíveis em falhas de rede.
- Dispositivos: atualizações completas de contingência passam de 20 para 60 segundos, pausam em aba oculta, mantendo eventos em tempo real filtrados.
- Tabelas móveis com rótulos no React, sem MutationObserver global; dados principais compactos e informações extras expansíveis.
- Clientes comerciais: busca com debounce de 350 ms, cancelamento de requisições antigas e paginação real de 30 itens (antes só a primeira página de até 50).
- Portal: atualização seletiva de perfil, códigos, fontes e contadores após eventos.

### Superadmin
- As mesmas melhorias de listas, dispositivos e tabelas móveis.
- Nova ferramenta `Migração de legados` em Atendimento e TVs, também listada dentro do dashboard da área.
- Inventário por revenda, situação das ativações, licença vigente, proprietário, MAC compartilhado, plataforma/versão quando conhecidos.
- Importação **explícita** de ficha comercial legada para `commerce_customers`.
- Seleção/criação de plano comercial; criação e aprovação *explícitas* de assinatura.
- Vínculo **explícito** de ativação e licença técnica já vigentes a uma vaga comercial, com transação e auditoria.

### Backend
- APIs Superadmin: `GET /api/v1/admin/devices/legacy-migration/preview`, `POST .../import-customer`, `POST .../link-activation`.
- Restrição a Superadmin e permissões do backend; operações identificam parceiro, cadastro legado, ativação e assinatura.
- Não cria, renova, transfere ou altera licenças e suas datas; não altera estoques, PIX, créditos ou dispositivos.
- Migração sem backfill em massa. Ativações sem cadastro legado precisam de revisão fora deste assistente; MAC com mais de uma parceria exige confirmação explícita.
- **Nenhuma migração SQL adicionada**, reutiliza tabelas das migrações de 2026-10/12 já aplicadas.
- Script de registro de rotas faz backup do `admin.routes.js`; **não substitui `src/app.js`**.

## Aplicação segura — homologação primeiro

Use **cada ZIP em sua pasta**, nunca os três no mesmo diretório. Verifique que a VPS já tem a base mais recente do código e faça backups do projeto e do PostgreSQL antes de aplicar.

### 1. Backend — instalar primeiro

```bash
cd /var/www/backend-deltaTV
# Backup recomendado em outro local/disco antes de modificar
unzip -o DeltaTV-legados-backend-hotfix.zip
node scripts/install-legacy-migration.mjs          # simulação, sem mudanças
node scripts/install-legacy-migration.mjs --apply  # registro de rota, com backup
node --check src/modules/admin.routes.js
node --test tests/unit/legacy-migration-*.test.js
pm2 restart DeltaTV-Server --update-env
pm2 logs DeltaTV-Server --lines 60 --nostream
```

**Atenção:** o histórico anterior aponta `20261217000001-tv-messages.cjs` como migração pendente e conflitante. **Não execute `npm run db:migrate` para instalar este hotfix.** Resolva o conflito de mensagens separadamente; este hotfix não depende dele. Não use comandos `DROP` ou rollback automático.

Verifique o endpoint de inventário com uma sessão autenticada de Superadmin. Espera-se `200` com `{ data,meta,summary,missingClientRecords }`. O endpoint não é público; um visitante ou conta sem permissão deve receber `401/403`, não um inventário.

### 2. Admin

```bash
cd /var/www/painel-admin-DeltaTV
unzip -o DeltaTV-mobile-admin-e-legados-hotfix.zip
npm test
npm run build
```

Abra o painel em uma conta Superadmin: `Atendimento e TVs > Migração de legados`. Escolha uma revenda de teste, confira o inventário e a prévia; só execute operações de POST em homologação depois de checar os dados.

### 3. Revenda

```bash
cd /var/www/revenda-DeltaTV
unzip -o DeltaTV-mobile-revenda-hotfix.zip
npm test
npm run build
```

Teste `Dispositivos`, `Clientes`, rolagem em celular, busca digitando rapidamente, próxima/anterior, navegação e ações da TV. Faça a comparação de velocidade antes/depois com o navegador.

### 4. Nginx e cache

Se `npm run build` concluir mas a UI não mudar, verifique o `root` configurado pelo Nginx, o `dist/assets` publicado e o cache do navegador/Cloudflare. O backend não precisa de reinício do Nginx.

## Regras de migração e limitações

1. O inventário trabalha sobre `reseller_clients` e ativações vinculadas por parceiro+MAC. **Não cobre automaticamente toda ativação órfã**: informa quantas não possuem ficha legada.
2. Vínculos com vários parceiros, ativação bloqueada ou duplicada, licença vencida/sem proprietário compatível não são migrados automaticamente.
3. A operação pode criar uma ficha, um plano ou uma assinatura comercial, **mas isso não altera o licenciamento técnico da TV**. A ativação existente continua no mesmo prazo.
4. Um plano de recursos novos só deve ser concedido depois de avaliar as capacidades e a versão do aplicativo instalado. A interface registra o dado disponível; **não instala app, não força upgrade e não habilita recursos incompatíveis**.
5. `acknowledgeSharedMac` exige revisão de MAC compartilhado, mas não substitui confirmação de titularidade na operação real.
6. A migração é por escolha explícita de um cadastro e uma ativação, com auditoria. Não existe botão de migração em massa nesta entrega.
7. A reversão de vínculos comerciais deve ser feita conscientemente pelo fluxo de liberação de vaga; não altere dados históricos diretamente no PostgreSQL.

## Validação local realizada

- Admin `npm test`: 20 aprovados, 1 ignorado, 0 falhas.
- Revenda `npm test`: 56 aprovados, 1 ignorado, 0 falhas.
- Backend: 7 testes específicos aprovados, incluindo idempotência do instalador.
- Análise sintática (TypeScript parser, JS/JSX): Admin 70 arquivos; Revenda 62; Backend 295; imports relativos verificados.
- Não foi possível executar **build Vite completo**, testes visuais em smartphone real ou integração PostgreSQL nesta sessão (dependências de renderização/DB indisponíveis). **Homologue antes de publicar.**

## Recuperação

Preserve cópia integral dos arquivos anteriores. O instalador backend guarda cópia com extensão `backup-<timestamp>` de `src/modules/admin.routes.js`. Em caso de problema, interrompa o deploy, restaure o build/pasta anterior do painel correspondente, restaure o registro de rotas do backup e reinicie apenas a API. **Não reverta licenças nem migre banco por conta desta atualização**.
