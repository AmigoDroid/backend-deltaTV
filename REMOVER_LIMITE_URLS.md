# URLs por código sem teto global de oito

- O catálogo de planos agora aceita qualquer limite inteiro positivo (até o intervalo do INTEGER do PostgreSQL) **ou** `null`, que significa ilimitado.
- Exceção individual: `maxServersOverride: null` herda o plano; `0` = ilimitado; valores positivos definem um limite próprio.
- A Revenda Básico ainda começa com **1 URL** e sem failover; Profissional **4**; Premium **8**. Você pode personalizar estes limites no Superadmin.
- Na configuração de servidores do código, a API respeita o limite efetivo e não possui mais teto global de 8.
- O monitor continua com limite de sondagens simultâneas e por ciclo. **Ilimitado não é capacidade infinita da VPS**: configure quantidades razoáveis e acompanhe CPU, RAM e idade das medições.

## Instalação

1. Backup do PostgreSQL.
2. Atualize o backend e execute `npm run db:migrate` para aplicar `20261118000001-unlimited-plan-urls.cjs` antes de reiniciar o Node no PM2.
3. Atualize e compile os painéis do Admin e Parceiro com `npm run build`.
4. Teste um plano com 12 URLs e outro ilimitado, e confirme que a Revenda Básico permanece limitada a uma URL.

Os dados existentes são preservados e os valores atuais dos planos não são alterados automaticamente.
