# Alerta de latência — portal da revenda

- Rota protegida: `GET /api/v1/partner/server-monitor/alerts`.
- A consulta é sempre restrita ao `partnerId` autenticado pelo JWT; não aceita um parceiro informado pelo cliente.
- Não realiza novas sondagens. Consulta somente `partner_providers` e `provider_health` já atualizados pelo monitor.
- Resposta enxuta: até três servidores problemáticos, contadores totais e limite em milissegundos. O domínio é retornado sem usuário, senha ou parâmetros de URL.
- Mostra somente medições recentes. `PROVIDER_MONITOR_SLOW_MS` (padrão 2500 ms) define o limiar de lentidão.
- Se a sondagem atingir o timeout (`PROVIDER_MONITOR_TIMEOUT_MS`, padrão 3000 ms), o painel reportará uma falha de disponibilidade em vez de afirmar uma latência exata superior ao timeout.
- Cache local de 15 segundos por parceiro, limitado a 500 entradas; WebSocket `server-health` invalida o cache ao detectar mudanças. Não adiciona novo processo, banco, Redis, tabela ou migration.
- Para habilitar: `ENABLE_SCHEDULER=true` e `PROVIDER_MONITOR_ENABLED=true` no backend que executa o monitor.
- O alerta não desativa licenças, modifica códigos nem altera o modo de entrega. É exclusivamente informativo.
- Produção: ativar o monitor em um único processo PM2, homologar com URLs próprias e conferir a janela de timeout. Validar Nginx /ws e CORS para eventos WebSocket.

## Exemplo conceitual

```json
{
  "monitorEnabled": true,
  "thresholdMs": 2500,
  "total": 1,
  "slow": 1,
  "down": 0,
  "unstable": 0,
  "items": [
    { "id": "...", "name": "Servidor A", "host": "servidor.exemplo", "latencyMs": 2700, "kind": "slow" }
  ]
}
```

Para testar em ambiente local, use um servidor de testes sob seu controle; não ajuste o limite por conta de uma medição isolada em produção.
