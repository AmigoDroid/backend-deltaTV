/** Metadata público do ambiente. Não inclua tokens, chaves, ou URLs com segredos. */
export const safePublicOrigin = base => {
  try {
    const parsed = new URL(base);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch { return null; }
};
export const webhookCatalog = base => {
  const origin = safePublicOrigin(base);
  const url = path => origin ? `${origin}/api/v1/webhooks/${path}` : null;
  return [
    { id: 'portal-infinitepay', group: 'Painel do Parceiro', provider: 'InfinitePay', url: url('portal-sales/infinitepay'), authentication: 'Pagamento conferido em payment_check; aviso não assinado', dynamic: false },
    { id: 'portal-mercadopago', group: 'Painel do Parceiro', provider: 'Mercado Pago', url: url('portal-sales/mercadopago'), authentication: 'Assinatura x-signature + consulta da transação', dynamic: false },
    { id: 'legacy-mercadopago', group: 'Pix legado da plataforma', provider: 'Mercado Pago', url: url('pix/mercadopago'), authentication: 'Assinatura x-signature + consulta da transação', dynamic: false },
    { id: 'master-infinitepay', group: 'Revendas de TV (recebimento próprio)', provider: 'InfinitePay', url: url('master-pix/infinitepay/{id-do-vendedor}'), authentication: 'Pagamento conferido em payment_check', dynamic: true },
    { id: 'master-mercadopago', group: 'Revendas de TV (recebimento próprio)', provider: 'Mercado Pago', url: url('master-pix/mercadopago/{id-do-vendedor}'), authentication: 'Assinatura + consulta da transação', dynamic: true },
    { id: 'generic-invoices', group: 'Faturas externas (legado)', provider: 'Webhook genérico', url: url('payments/generic'), authentication: 'HMAC-SHA256 com WEBHOOK_SECRET', dynamic: false },
  ];
};
