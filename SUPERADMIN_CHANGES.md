# Alterações — superadmin e presença de revendas

- Superadmin pode definir limite de dispositivos/ativações inferior à utilização atual (não remove vínculos existentes; verificações futuras ainda aplicam o limite).
- Superadmin ignora teto de fichas nas rotas administrativas; demais perfis mantêm 10.000.
- Superadmin pode lançar estoque em revendas canceladas/bloqueadas, respeitando tipo de cadastro e não-negatividade.
- Superadmin pode renovar licenças bloqueadas/canceladas, reativando-as.
- Presença do portal: contas partner autenticadas atualizam `last_activity_at` no máximo uma vez/minuto; uma revenda está online se alguma conta ativa tem atividade há menos de 180 s.
- A lista mostra o estado de presença e a última atividade, com atualização a cada minuto. A presença mede uso do portal, não os dispositivos.

## Deploy
Executar `npm run db:migrate` no backend **antes** de reiniciar o servidor. Implantar frontend recompilando (`npm ci && npm run build`). Faça backup do banco primeiro.

## Escopo não implementado
Não foram adicionadas exclusão forçada de dispositivos com histórico, restauração sem credenciais, edição forçada de faturas pagas, remoção de vínculos conflitantes, mudança de código com estoque incompatível, nem alteração/rebaixamento do último superadmin. Essas operações precisam de fluxos transacionais e testes próprios; não é seguro simplesmente ignorar as restrições do banco.
