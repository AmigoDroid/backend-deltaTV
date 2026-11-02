# Online em tempo real — Delta TV

## Mudanças
- Backend: emite `device-presence` via `/ws` apenas quando a contagem de dispositivos online muda, incluindo expiração da janela de presença. Verificação a cada 10 segundos. Emite `partner-presence` ao conectar/desconectar portal da revenda (já existente).
- Superadmin: consome `device-presence` e atualiza o cartão de dispositivos sem nova requisição. O contador de revendas continua consumindo `partner-presence`. REST é usado no primeiro carregamento, recuperação de conexão e sincronização eventual.
- Não é necessário atualizar o projeto do portal da revenda nesta correção.

## Teste local
1. Inicialize backend atualizado com dependências e migrações já instaladas.
2. Execute painel admin e portal revenda existentes.
3. Em Rede > WS, valide `/ws` 101 e `ready`.
4. Entre no portal da revenda e confirme que a contagem de revendas online muda imediatamente.
5. Envie heartbeat de dispositivo e confirme que o contador de dispositivos muda em até 10 segundos; aguarde o vencimento da janela e confirme que diminui.

## Limites
- A presença de aparelhos ainda se baseia em heartbeat HTTP, não WebSocket da TV.
- Num backend com múltiplos processos Node, a contagem/eventos precisam de uma camada compartilhada (Redis/pubsub) para consistência entre instâncias.
- `npm run build` do painel não foi validado neste ambiente por falta da dependência yallist no cache npm.
