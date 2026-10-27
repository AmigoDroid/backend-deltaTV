import crypto from "node:crypto";
import { AppError } from "../../../shared/errors.js";

/**
 * Provedor de TESTE (PIX_PROVIDER=mock; recusado em produção pelo env.js). Não fala com nenhum banco: o "pagamento" é
 * marcado pelo admin no painel (botão "Simular pagamento") ou por simulate(). Estado em memória (some ao reiniciar).
 */
const payments = new Map(); // providerRef -> { amountCents, externalReference, status, paidAt }

export function createMock() {
  return {
    name: "mock",
    async createCharge({ id, amountCents, expiresAt }) {
      const providerRef = String(Date.now()) + String(crypto.randomInt(1000, 9999));
      payments.set(providerRef, { amountCents, externalReference: id, status: "pending", paidAt: null });
      return { providerRef, qrCode: `00020126MOCKPIX${providerRef}5204000053039865802BR`, qrCodeBase64: null, ticketUrl: null, expiresAt };
    },
    async getPayment(providerRef) {
      const p = payments.get(String(providerRef));
      if (!p) throw new AppError(404, "PIX_PAYMENT_NOT_FOUND", "Pagamento não encontrado no provedor.");
      return { providerRef: String(providerRef), status: p.status, rawStatus: p.status, amountCents: p.amountCents, externalReference: p.externalReference, paidAt: p.paidAt };
    },
    simulate(providerRef, status = "paid", { amountCents } = {}) {
      const p = payments.get(String(providerRef));
      if (!p) throw new AppError(404, "PIX_PAYMENT_NOT_FOUND", "Pagamento simulado não encontrado (o servidor foi reiniciado?).");
      p.status = status;
      if (amountCents != null) p.amountCents = amountCents; // testes: simula pagamento de valor diferente do cobrado
      if (status === "paid") p.paidAt = new Date();
    },
    verifyWebhook: () => false, // o mock não recebe webhooks
    paymentIdFromWebhook: () => null,
  };
}
