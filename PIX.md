# Pagamento por Pix (Mercado Pago)

Revendedores pagam por Pix e **a entrega é automática**:

- **Compra de licenças** (revendedor): escolhe duração + quantidade → QR Code → ao pagar, as licenças entram no estoque na hora.
- **Mensalidade** (parceiro de conteúdo / qualquer parceiro com fatura): botão "Pagar com Pix" na fatura → ao pagar, a fatura é quitada e, se a conta estava suspensa por atraso, é reativada.

O preço nunca vem do navegador: o servidor calcula (tabela de preços / saldo da fatura) e confere o valor pago direto na API do Mercado Pago.

## 1. Banco de dados
```bash
npm run db:migrate        # cria license_prices e pix_charges (migration 20261028000001)
```

## 2. Mercado Pago
1. Conta no Mercado Pago com **chave Pix cadastrada** (necessária para gerar cobranças Pix).
2. https://www.mercadopago.com.br/developers → *Suas integrações* → criar aplicação.
3. *Credenciais de produção* → copie o **Access Token**.
4. *Webhooks* → modo produção → URL `https://SEU-DOMINIO/api/v1/webhooks/pix/mercadopago` → evento **Pagamentos** → copie a **Chave secreta**.

## 3. `.env` do servidor
```
PIX_PROVIDER=mercadopago
MP_ACCESS_TOKEN=APP_USR-...
MP_WEBHOOK_SECRET=...
PUBLIC_BASE_URL=https://SEU-DOMINIO     # HTTPS e público (o Mercado Pago precisa alcançar o webhook)
PIX_EXPIRATION_MINUTES=60
```
Reinicie o servidor. Sem `PIX_PROVIDER` o Pix fica desligado (os revendedores não veem os botões).

## 4. Defina os preços (painel admin → Pix → Preços das licenças)
Preço de **1 licença** por duração (ex.: 1 mês R$ 15, 12 meses R$ 120). Dá para criar preços especiais para um revendedor (sobrepõem a tabela geral) ou esconder uma duração para ele.

## 5. Testar sem dinheiro
`PIX_PROVIDER=mock` (apenas desenvolvimento; recusado em produção): o admin vê o botão **Simular pagamento** em Pix → Cobranças.

## Segurança / robustez
- Webhook com assinatura HMAC (`x-signature`); mesmo assim o servidor **reconsulta o pagamento** na API do Mercado Pago antes de entregar.
- Entrega atômica e idempotente (webhook repetido, polling e conciliação não entregam duas vezes).
- Job a cada 2 min reconsulta Pix pendentes (se o webhook se perder) e expira os vencidos.
- Valor pago diferente do cobrado, fatura já quitada ou cadastro bloqueado → cobrança vai para **Em conferência** (painel admin), nada é entregue "no escuro".
