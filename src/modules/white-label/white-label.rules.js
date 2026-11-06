// Regras independentes do banco, testáveis sem dependências externas.
export const utcDay = (now = new Date()) => new Date(now).toISOString().slice(0, 10);
export function extendMonthlyAccess(previousDate, months, now = new Date()) {
  if (!Number.isInteger(months) || months < 1 || months > 24) throw new RangeError("Meses devem estar entre 1 e 24.");
  const current = utcDay(now);
  const baseline = previousDate && previousDate >= current ? previousDate : null;
  const [year, month] = baseline ? baseline.split("-").map(Number) : [now.getUTCFullYear(), now.getUTCMonth() + 1];
  // Se há uma competência já paga, estender a partir do MÊS SEGUINTE.
  const startMonth = baseline ? month : month - 1;
  return new Date(Date.UTC(year, startMonth + months, 0)).toISOString().slice(0, 10);
}
export const effectiveAppState = (app, partnerStatus, now = new Date()) => {
  if (partnerStatus !== "active") return "owner_inactive";
  if (app.status !== "active") return app.status;
  if (!app.paidThrough || app.paidThrough < utcDay(now)) return "payment_required";
  return "active";
};
