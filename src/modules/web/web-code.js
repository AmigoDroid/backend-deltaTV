import crypto from "node:crypto";

/**
 * Código de acesso do Player Web: 2 letras + 6 dígitos (ex.: AB123456).
 *
 * - Gerado só pelo servidor (CSPRNG). Quem o gera é o revendedor (ou o admin) no painel.
 * - É uma CREDENCIAL: o banco guarda só HMAC(código, pepper) para conferir o login e uma cópia cifrada para o dono do
 *   código poder consultá-lo de novo no painel. Por isso o login tem limitador por código e por IP.
 * - Letras I e O não são sorteadas (confundem com 1 e 0 quando o cliente digita). Na entrada, qualquer letra A–Z vale.
 * - Módulo puro (sem banco, sem env): testável isoladamente.
 */
export const WEB_CODE_RE = /^[A-Z]{2}[0-9]{6}$/;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // sem I e O

export function generateWebCode() {
  const l = () => LETTERS[crypto.randomInt(LETTERS.length)];
  let digits = "";
  for (let i = 0; i < 6; i++) digits += crypto.randomInt(10);
  return `${l()}${l()}${digits}`;
}

/** "ab 123-456" -> "AB123456". Devolve "" se não tiver a forma de um código (nunca lança). */
export function normalizeWebCode(input) {
  if (typeof input !== "string") return "";
  const code = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return WEB_CODE_RE.test(code) ? code : "";
}

/** Exibição agrupada: AB123456 -> "AB 123456". */
export const formatWebCode = (code) => (WEB_CODE_RE.test(code) ? `${code.slice(0, 2)} ${code.slice(2)}` : code);

/** MAC virtual (administrado localmente: bit 0x02 do 1º byte) do dispositivo web. Prefixo 02:57:45 ("WE"). */
export function generateWebMac() {
  const b = crypto.randomBytes(3);
  return `02:57:45:${[...b].map((x) => x.toString(16).padStart(2, "0")).join(":")}`.toUpperCase();
}
