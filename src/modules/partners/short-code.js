import crypto from "node:crypto";

/**
 * Código curto do parceiro (ex.: 4343): identifica a parceria e o servidor, mas NÃO é segredo.
 * 4–12 caracteres [A-Z0-9], sempre em maiúsculas. Unicidade global garantida por índice único no banco.
 * "OLD..." é reservado para códigos antigos migrados (revogados).
 */
export const SHORT_CODE_RE = /^[A-Z0-9]{4,12}$/;
export const RESERVED_PREFIX = "OLD";

export const normalizeShortCode = (v) => (typeof v === "string" ? v.trim().toUpperCase() : "");

export function shortCodeProblem(code) {
  if (!SHORT_CODE_RE.test(code)) return "Use de 4 a 12 letras ou números, sem espaços ou símbolos.";
  if (code.startsWith(RESERVED_PREFIX)) return `Códigos iniciados por ${RESERVED_PREFIX} são reservados.`;
  return null;
}

export function randomNumericCode(length) {
  let s = "";
  for (let i = 0; i < length; i++) s += crypto.randomInt(10);
  return s;
}
