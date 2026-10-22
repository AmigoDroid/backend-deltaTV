# Modo Xtream (sem lista M3U)

O servidor **não baixa, converte nem guarda lista M3U**. Ele só:

1. valida a licença/sessão do aparelho (como antes);
2. descobre o painel + usuário + senha do aparelho (parceria cadastrada, ou a URL da própria lista no padrão Xtream);
3. confere no painel que a conta está ativa (`player_api.php`, resposta de poucos KB) e entrega a conexão ao app.

O app da TV consulta a API Xtream direto: categorias, canais, filmes, séries, temporadas e episódios, por categoria e sob demanda.

## Rotas (prefixo `/api/v1/client`)

| Rota | O que faz |
|---|---|
| `GET /resources` | Lista com uma única fonte (`me`, tipo `xtream`) se o aparelho tem lista; vazia se não tem. |
| `GET /xtream` | `{ baseUrl, username, password, userAgent, account, expiresAt }`. Exige sessão válida (403 se o painel recusar a conta). |
| `POST /play-token` | Mantido apenas para compatibilidade com instalações antigas; o Roku não o solicita para streams Xtream diretos. |

O Roku consulta `GET /status` ao abrir e periodicamente; também atualiza a configuração Xtream quando necessário. A reprodução vai diretamente ao fornecedor e não leva token Delta.
A migration `20261019000001` remove as tabelas de catálogo persistente (`catalog_items`, `catalog_series`, `catalog_groups`, `catalog_imports`) para liberar o espaço ocupado por importações antigas.

## Atenção

- O usuário/senha do provedor passam a chegar ao aparelho (o app precisa deles para consultar o painel e tocar os streams).
  Só são entregues a uma sessão válida de uma ativação autorizada, e o app mantém a configuração em cache por no máximo 60 segundos.
- Revogar/bloquear o aparelho impede novas consultas e o Roku para a reprodução ao detectar a revogação na verificação periódica. Como o stream é direto no fornecedor, não é possível garantir corte instantâneo se a TV estiver desconectada ou se o fornecedor continuar entregando a URL.
- Fontes de conteúdo cadastradas manualmente (playlist/catálogo de canais) deixam de aparecer na TV.
