# Delta TV — sondagem compartilhada de URLs

## O que mudou

O monitor de servidores agora utiliza `probe-dedup.js` para reaproveitar o resultado
HTTP de um mesmo destino de monitoramento entre cadastros de diferentes parceiros.
Por exemplo, 40 cadastros com `https://origem.exemplo` no mesmo intervalo geram
**uma requisição de sondagem**, não 40. Host em maiúsculas e portas padrão são
normalizados. HTTP e HTTPS, hosts e portas diferentes continuam independentes.

**Importante:** o monitor testa `GET /player_api.php` *sem credenciais* e *sem baixar
catálogos*. Apenas esse resultado técnico é compartilhado. Cada parceiro/provedor
mantém seu próprio registro `provider_health`, limiares de falhas, histórico,
permissões e alertas. Nenhuma credencial ou lista é colocada no cache.

## Controle de recursos

- Sondagens simultâneas para a mesma URL são unificadas (single-flight).
- Resultados recentes são mantidos em cache LRU com **no máximo 1.000 URLs**.
- TTL padrão: **um intervalo de monitoramento** (máximo 120 segundos).
- Medição reutilizada mantém o instante original da coleta: o mesmo resultado não
  conta duas vezes como duas falhas/duas recuperações para o mesmo servidor.
- O monitor preserva os limites existentes de concorrência, itens por rodada,
  timeout, verificação SSRF, histórico e notificações.
- A cada 10 rodadas, o processo escreve no log PM2 os contadores acumulados:
  `sondagens HTTP`, `reutilizações`, `coalescências` e `cache`.

## Configuração opcional

```env
PROVIDER_MONITOR_DEDUP_TTL_MS=60000
```

Deixar de configurar a variável também funciona: o padrão acompanha o intervalo
configurado em `PROVIDER_MONITOR_INTERVAL_SECONDS` (até 120 s). Não use TTL muito
alto: pode retardar a detecção de uma mudança. Para uma VPS de 2 GB de RAM, o
cache de 1.000 entradas ocupa pouca memória.

## Implantação

Não requer novas tabelas ou migrações e **não** requer Redis ou mudanças no
Nginx. Atualize somente o backend, instale as dependências se necessário e
reinicie o processo PM2, preservando o `.env` de produção.

Ative jobs e monitor **em apenas uma instância** da API. Se houver múltiplos
processos PM2 com o monitor ligado, cada processo manterá o próprio cache e
poderá fazer sondagens duplicadas, pois o cache é local ao processo.

Valide: `npm run test:unit`, status do monitor e `pm2 logs`. Os testes unitários
não substituem um teste real com PostgreSQL e servidores de homologação.
