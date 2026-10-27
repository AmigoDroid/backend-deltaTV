/**
 * Regras puras dos clientes do revendedor (sem banco): normalização/validação de campos e datas.
 * Convenção dos parse*: { value } quando ok (undefined = campo não enviado; null = limpar o campo) ou { error }.
 */
export const DUE_SOON_DAYS = 7;
export const FILTERS = ["all", "overdue", "due_soon", "no_due", "unregistered"];

/** Texto livre: apara e colapsa espaços; vazio vira null; undefined = não enviado. */
export function cleanText(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

/** Hoje (YYYY-MM-DD) em São Paulo: o "dia" que o revendedor enxerga ao dizer que algo venceu. */
export const todaySP = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);

/** Telefone com máscara: só dígitos e + ( ) - . espaço; 8 a 15 dígitos (E.164 tem no máximo 15). */
export function parsePhone(v) {
  const s = cleanText(v);
  if (s === undefined || s === null) return { value: s };
  if (!/^[0-9+()\-.\s]+$/.test(s)) return { error: "Telefone inválido: use só números, espaço, + ( ) - ." };
  const digits = s.replace(/\D/g, "").length;
  if (digits < 8 || digits > 15) return { error: "Telefone inválido: informe de 8 a 15 dígitos (com DDD)." };
  return { value: s };
}

/** Vencimento: "AAAA-MM-DD" de uma data real entre 2000 e 2100. */
export function parseDueDate(v) {
  if (v === undefined) return { value: undefined };
  if (v === null || v === "") return { value: null };
  const s = String(v);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
  if (!ok) return { error: "Data de vencimento inválida." };
  const year = Number(s.slice(0, 4));
  if (year < 2000 || year > 2100) return { error: "Data de vencimento fora do intervalo permitido." };
  return { value: s };
}

/** Dias inteiros de hoje (SP) até a data (negativo = já venceu). null sem data. */
export function daysUntil(ymd, now = new Date()) {
  if (!ymd) return null;
  return Math.round((Date.parse(`${ymd}T00:00:00Z`) - Date.parse(`${todaySP(now)}T00:00:00Z`)) / 86_400_000);
}
