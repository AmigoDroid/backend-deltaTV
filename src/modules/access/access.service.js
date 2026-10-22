import { Op } from "sequelize";
import { sequelize, Activation, License, Partner, PartnerProvider, DeviceSession } from "../../db/models/index.js";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { signJwt, randomToken, sha256 } from "../../shared/crypto.js";
import { evaluateAccess } from "./access.policy.js";
import { sessionsToRevoke } from "./session-cap.js";

// Fatura vencida mais antiga ainda não quitada (data em UTC) — base da política de inadimplência.
export async function overdueSinceFor(partnerId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT to_char(MIN(due_date), 'YYYY-MM-DD') AS d FROM invoices
      WHERE partner_id = :partnerId AND status IN ('open','partial','overdue')
        AND due_date < (now() AT TIME ZONE 'UTC')::date`,
    { replacements: { partnerId }, transaction },
  );
  return rows[0]?.d ?? null;
}

/** Carrega o estado ATUAL no banco e aplica a política. Chamado em toda requisição protegida. */
export async function checkActivation(activationId, { now = new Date(), transaction } = {}) {
  const activation = await Activation.findByPk(activationId, { include: [License, Partner, PartnerProvider], transaction });
  if (!activation) return { activation: null, decision: evaluateAccess({ activation: null }) };
  const overdueSince = activation.partnerId ? await overdueSinceFor(activation.partnerId, transaction) : null;
  const decision = evaluateAccess({
    activation, license: activation.License, partner: activation.Partner, now, overdueSince,
  });
  return { activation, decision };
}

export const denialError = (decision) => new AppError(403, decision.code, decision.message);

/* ---------- Tokens e sessões de dispositivo ---------- */

export const accessTokenFor = (activationId, sessionId) =>
  signJwt({ typ: "device", sid: sessionId, aid: activationId }, env.deviceAccessTtl);

export const playTokenFor = (activationId, sessionId) =>
  signJwt({ typ: "play", sid: sessionId, aid: activationId }, env.playTokenTtl);

export async function issueSession(activation, meta = {}, transaction) {
  const refreshToken = randomToken(48);
  const session = await DeviceSession.create(
    {
      activationId: activation.id,
      refreshHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + env.deviceRefreshTtlDays * 86400000),
      ip: meta.ip,
      userAgent: (meta.userAgent || "").slice(0, 300),
    },
    { transaction },
  );
  return {
    accessToken: accessTokenFor(activation.id, session.id),
    refreshToken,
    expiresIn: env.deviceAccessTtl,
    sessionId: session.id,
  };
}

// Refresh = revalidação: se o acesso foi bloqueado/expirou, não emite novos tokens.
export async function refreshSession(refreshToken, { installationId } = {}) {
  const session = await DeviceSession.findOne({
    where: { refreshHash: sha256(refreshToken), revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
  });
  if (!session) throw new AppError(401, "INVALID_REFRESH_TOKEN", "Sessão inválida ou expirada.");
  const { activation, decision } = await checkActivation(session.activationId);
  if (!decision.allowed) throw denialError(decision);
  if (activation.installationId && installationId && activation.installationId !== installationId) {
    throw new AppError(403, "INSTALLATION_MISMATCH", "Instalação não reconhecida.");
  }
  const next = randomToken(48);
  await session.update({ refreshHash: sha256(next), lastUsedAt: new Date(), expiresAt: new Date(Date.now() + env.deviceRefreshTtlDays * 86400000) });
  return {
    activation, decision,
    tokens: { accessToken: accessTokenFor(activation.id, session.id), refreshToken: next, expiresIn: env.deviceAccessTtl },
  };
}

/** Revoga as sessões mais antigas além do teto, para abrir espaço a uma nova. Chamar dentro da transação que cria a sessão. */
export async function enforceSessionCap(activationId, transaction) {
  const rows = await DeviceSession.findAll({
    where: { activationId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
    attributes: ["id", "createdAt", "revokedAt", "expiresAt"], transaction, lock: transaction.LOCK.UPDATE,
  });
  const ids = sessionsToRevoke(rows.map((r) => r.toJSON()), env.maxSessionsPerActivation);
  if (ids.length) await DeviceSession.update({ revokedAt: new Date() }, { where: { id: { [Op.in]: ids } }, transaction });
  return ids.length;
}

export async function revokeSessionsOf(activationId, transaction) {
  await DeviceSession.update({ revokedAt: new Date() }, { where: { activationId, revokedAt: null }, transaction });
}
