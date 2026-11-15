import { AppError } from "../../shared/errors.js";
export function adjustedExpiry(
  { startsAt, expiresAt },
  { expiresAt: manual, deltaDays },
) {
  const next = manual
    ? new Date(manual)
    : new Date(new Date(expiresAt).getTime() + deltaDays * 86400000);
  if (
    !startsAt ||
    !Number.isFinite(next.getTime()) ||
    next <= new Date(startsAt)
  )
    throw new AppError(
      422,
      "INVALID_EXPIRY",
      "O vencimento deve ser posterior ao início da licença.",
    );
  return next;
}
export function allowedRolePermissions(baseRole, permissions, catalog) {
  const allowed = catalog[baseRole] || [];
  if (permissions.some((p) => !allowed.includes(p)))
    throw new AppError(
      422,
      "INVALID_PERMISSION",
      "O papel só pode restringir as permissões da função base.",
    );
  return [...new Set(permissions)].sort();
}
export function reportPeriod({ from, to }) {
  const end = to ? new Date(to) : new Date(),
    start = from ? new Date(from) : new Date(end.getTime() - 30 * 86400000);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end <= start ||
    end - start > 367 * 86400000
  )
    throw new AppError(
      422,
      "INVALID_PERIOD",
      "Selecione um período de até 366 dias, com fim posterior ao início.",
    );
  return { start, end };
}
export const csvCell = (value) =>
  '"' +
  String(value ?? "")
    .replace(/^[\t\r\n]|^\s*[=+\-@]/, "'$&")
    .replaceAll('"', '""') +
  '"';
