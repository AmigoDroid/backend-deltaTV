// Regra de datas: tudo é armazenado e calculado em UTC (timestamptz).
// A interface exibe em America/Sao_Paulo. Competências são "YYYY-MM".

// Regra de negócio: 1 mês de licença = 30 dias corridos (N meses = N × 30 dias), sempre calculado no backend.
// Não usar mês de calendário aqui: ele dá 28–31 dias e fazia a licença de "1 mês" durar 31 dias em alguns meses.
export const LICENSE_DAYS_PER_MONTH = 30;
const DAY_MS = 86_400_000;

export function addLicenseMonthsUTC(date, months) {
  if (!Number.isInteger(months) || months < 1) throw new RangeError(`Duração inválida: ${months} mês(es).`);
  return new Date(new Date(date).getTime() + months * LICENSE_DAYS_PER_MONTH * DAY_MS);
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
