export const GATEWAY_PROVIDERS = Object.freeze(['mercadopago', 'infinitepay', 'manual_pix']);
export const GATEWAY_LABELS = Object.freeze({ mercadopago: 'Mercado Pago', infinitepay: 'InfinitePay', manual_pix: 'Pix com minha chave' });
export const isProvider = (value) => GATEWAY_PROVIDERS.includes(value);
export const MANUAL_ORDER_TTL_MS = 24 * 3600_000;
export const CHECKOUT_TTL_MS = 60 * 60_000;
