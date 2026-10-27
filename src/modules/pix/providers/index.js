import { env } from "../../../config/env.js";
import { AppError } from "../../../shared/errors.js";
import { createMercadoPago } from "./mercadopago.js";
import { createMock } from "./mock.js";

let instance = null;

export const pixEnabled = () => !!env.pixProvider;

/** Provedor configurado (PIX_PROVIDER). Pix desligado => 503 com mensagem clara. */
export function getProvider() {
  if (!env.pixProvider) throw new AppError(503, "PIX_DISABLED", "Pagamento por Pix não está habilitado. Fale com a plataforma.");
  if (!instance) {
    instance = env.pixProvider === "mock"
      ? createMock()
      : createMercadoPago({ accessToken: env.mpAccessToken, webhookSecret: env.mpWebhookSecret });
  }
  return instance;
}
