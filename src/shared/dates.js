// Regra de datas: tudo é armazenado e calculado em UTC (timestamptz).
// A interface exibe em America/Sao_Paulo. Competências são "YYYY-MM".

export function addMonthsUTC(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export const isCompetence = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

export function competenceBounds(competence) {
  const [y, m] = competence.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) }; // fim exclusivo
}

export function currentCompetence(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function dueDateFor(competence, dueDay) {
  const [y, m] = competence.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${competence}-${String(Math.min(dueDay, last)).padStart(2, "0")}`;
}

export const toDateOnly = (d) => new Date(d).toISOString().slice(0, 10);

// Dias inteiros entre duas datas "YYYY-MM-DD" (b - a).
export function daysBetween(a, b) {
  return Math.floor((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
