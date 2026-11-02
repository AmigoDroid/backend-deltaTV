# Delta TV — Portal do parceiro ampliado

## Escopo entregue

O painel do parceiro de conteúdo reutiliza o mesmo conjunto de áreas operacionais do portal da revenda, com as regras **de conteúdo**:

- Visão geral, contrato comercial, créditos, extrato de créditos e alocação nos códigos;
- Clientes por MAC (ficha, contato, vencimento e observações), com buscas/paginação;
- Dispositivos, ativações e licenças do contrato da própria parceria;
- Bloquear/desbloquear/desvincular uma ativação e atualizar uma lista já vinculada à parceria;
- Códigos: criar, editar descrição, limite de ativações e vencimento, revogar, reservar créditos, associar URLs;
- Servidores: adicionar, editar, excluir (quando não estiverem referenciados), monitorar e consultar histórico quando o plano incluir;
- Player Web com códigos **da própria parceria** e credenciais Xtream; não há concessão automática de licenças avulsas de cortesia;
- Notificações recebidas com histórico e confirmação de leitura. O Superadmin pode direcionar notificações para parceiros de conteúdo;
- Histórico pessoal de login, faturas, pagamentos e downloads autorizados;
- Perfil com atualização de contato e troca de senha.

## Diferenças deliberadas da Revenda

- **Estoque de licenças**, compra de pacotes Pix e transferência de licenças de revenda NÃO foram duplicados: são incompatíveis com contratos de conteúdo e seriam uma forma de burlar cobrança. O equivalente é a carteira e alocação de créditos do parceiro, com as opções de mensalidade e quantidade contratada.
- Player Web exige um código da própria parceria. Não admite playlist avulsa + licença de cortesia.
- O parceiro gerencia as ativações vinculadas à sua parceria e não pode alterar ativações de terceiros no mesmo MAC.
- Os termos e valores do contrato continuam controlados pelo Superadmin.

## Implantação

1. Faça backup dos diretórios e do banco de dados.
2. Atualize o **backend** antes de publicar o novo **painel do parceiro** e a atualização do painel **Superadmin** (notificações).
3. Nenhuma migração nova foi adicionada para estas funcionalidades; dependem das migrações anteriores de clientes, notificações, contratos, planos, WebAccess, downloads e créditos.
4. Mantenha o `.env` existente. Configure `VITE_API_URL=https://api.deltatv.com.br` em `.env.production` do parceiro; gere o build com `npm ci && npm run build`.
5. Nginx deve continuar servindo o build em `parceiro.deltatv.com.br` e encaminhando `/ws` no domínio de API.
6. Teste com uma conta de parceiro real de homologação, primeiro em ambiente de testes.

## Casos mínimos de homologação

- Parceiro A não consulta/edita cliente, dispositivo, código ou acesso Web do parceiro B.
- Ficha de cliente pode ser criada/editada/excluída sem excluir ativação.
- Listas existentes podem ser reconfiguradas somente com código do próprio parceiro.
- Plano por créditos: criar Player Web consome os créditos exigidos; saldo insuficiente impede a criação.
- Plano limitado: criação de uma nova ativação respeita limite.
- Notificações enviadas para parceiros são recebidas, marcadas como lidas e vistas no histórico do Superadmin.
- Dados financeiros e de login ficam restritos à própria conta.
- Menus e modais funcionam em smartphone sem rolagem horizontal.

## Verificações feitas neste pacote

- Sintaxe JavaScript da API com `node --check`;
- Sintaxe JSX com o compilador TypeScript no modo de verificação de sintaxe;
- Referências locais e integridade dos ZIPs.

**Limitação:** não foram realizados builds Vite completos nem testes de integração com PostgreSQL, Nginx e PM2 neste ambiente. Portanto, não publique diretamente em produção sem homologar.
