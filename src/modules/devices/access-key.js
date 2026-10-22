import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Chave numérica de 6 dígitos para login de dispositivo.
 *
 * - Aleatória (crypto.randomInt), independente de MAC/identificador/token de QR.
 * - Guardada só como HMAC-SHA256(pepper, deviceId + chave): amarrada ao dispositivo; o banco sozinho não a revela
 *   (com 10^6 combinações, o pepper é o que impede força bruta offline — proteja-o como um segredo).
 * - Validade curta, limite de tentativas, uso único. Estourar as tentativas INVALIDA a chave: é preciso gerar outra na TV.
 * - Funções puras: o serviço persiste `next` dentro de uma transação com SELECT … FOR UPDATE.
 */

export const KEY_DIGITS = 6;
export const KEY_DEFAULTS = Object.freeze({ ttlSeconds: 600, maxAttempts: 5 });

export function generateKey() {
  return String(randomInt(0, 10 ** KEY_DIGITS)).padStart(KEY_DIGITS, "0");
}

export function hashKey(deviceId, key, pepper) {
  if (!pepper || String(pepper).length < 16) throw new Error("pepper ausente ou curto demais");
  return createHmac("sha256", pepper).update(`${deviceId}\u0000${key}`).digest("hex");
}

export const isWellFormed = (key) => typeof key === "string" && /^\d{6}$/.test(key);

/** Cria o registro a persistir. Devolve a chave em claro UMA vez, para exibir na TV. */
export function newKeyRecord(deviceId, pepper, { now = new Date(), ttlSeconds = KEY_DEFAULTS.ttlSeconds } = {}) {
  const key = generateKey();
  return {
    key,
    record: {
      deviceId,
      keyHash: hashKey(deviceId, key, pepper),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      attempts: 0,
      usedAt: null,
      invalidatedAt: null,
    },
  };
}

/**
 * Avalia uma tentativa. Não muta `record`; devolve `next` (campos a gravar) e `reason` interno para auditoria.
 * Para o chamador (rota), todas as falhas devem virar a MESMA resposta externa (sem revelar se existe/expirou).
 */
export function evaluateKeyAttempt(record, deviceId, candidate, pepper, { now = new Date(), maxAttempts = KEY_DEFAULTS.maxAttempts } = {}) {
  if (!record) return { ok: false, reason: "no_key", next: null };
  if (record.usedAt) return { ok: false, reason: "used", next: null };
  if (record.invalidatedAt) return { ok: false, reason: "invalidated", next: null };
  if (record.expiresAt <= now) return { ok: false, reason: "expired", next: { invalidatedAt: now } };

  const attempts = record.attempts + 1;
  const wellFormed = isWellFormed(candidate);
  let match = false;
  if (wellFormed) {
    const a = Buffer.from(hashKey(deviceId, candidate, pepper), "hex");
    const b = Buffer.from(record.keyHash, "hex");
    match = a.length === b.length && timingSafeEqual(a, b);
  }
  if (match) return { ok: true, reason: "ok", next: { attempts, usedAt: now } };
  if (attempts >= maxAttempts) return { ok: false, reason: "attempts_exceeded", next: { attempts, invalidatedAt: now } };
  return { ok: false, reason: wellFormed ? "mismatch" : "malformed", next: { attempts } };
}
