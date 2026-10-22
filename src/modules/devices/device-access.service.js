import crypto from "node:crypto";
import { Op } from "sequelize";
import { sequelize, Device, DeviceAccessKey, DeviceScopedSession } from "../../db/models/index.js";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { normalizeMac } from "../../shared/mac.js";
import { randomToken, sha256 } from "../../shared/crypto.js";
import { newKeyRecord, evaluateKeyAttempt, KEY_DEFAULTS } from "./access-key.js";
import { removeList, selectLiveActivation } from "./reseller-devices.service.js";

/**
 * Acesso por chave de 6 dígitos (para quem não tem revendedor):
 *  1. A TV, JÁ COM SESSÃO VÁLIDA, pede uma chave (POST /client/device-key) e a mostra na tela. Sem sessão não há chave:
 *     assim quem só conhece o MAC não consegue gerá-la (ele só consegue a recuperação por MAC, que não dá acesso de gestão).
 *  2. A pessoa informa MAC + chave em POST /device-access/login e recebe uma sessão CURTA e LIMITADA àquele dispositivo.
 *  3. Com a sessão: consultar, configurar/substituir e remover a lista DAQUELE dispositivo. Nada além disso.
 * A chave vale 10 min, é de uso único, e 5 erros a invalidam (uma nova só sai da TV). Só o HMAC é guardado.
 */
const pepper = () => crypto.createHmac("sha256", env.jwtSecret).update("device-access-key/v1").digest("hex");
// Uma única mensagem para qualquer falha: MAC inexistente, chave errada, expirada ou já usada.
const invalid = () => new AppError(401, "INVALID_DEVICE_KEY", "MAC ou chave inválidos, ou chave expirada. Gere uma nova chave na TV.");

export async function issueDeviceKey({ deviceId, ip }) {
  return sequelize.transaction(async (transaction) => {
    const device = await Device.findByPk(deviceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!device?.mac) throw new AppError(404, "NOT_FOUND", "Dispositivo não encontrado.");
    const now = new Date();
    // No máximo uma chave viva: a anterior (ainda que não expirada) deixa de valer.
    await DeviceAccessKey.update({ invalidatedAt: now }, { where: { deviceId, usedAt: null, invalidatedAt: null }, transaction });
    const { key, record } = newKeyRecord(deviceId, pepper(), { now, ttlSeconds: KEY_DEFAULTS.ttlSeconds });
    await DeviceAccessKey.create({ deviceId, keyHash: record.keyHash, expiresAt: record.expiresAt, requestedIp: ip }, { transaction });
    await audit({ actor: { type: "device", id: deviceId, ip }, action: "device.key.issue", entityType: "device", entityId: deviceId, metadata: { mac: device.mac }, transaction });
    return { key, expiresAt: record.expiresAt, ttlSeconds: KEY_DEFAULTS.ttlSeconds };
  });
}

export async function loginWithKey({ mac: macInput, key, ip, userAgent }) {
  const mac = normalizeMac(macInput);
  if (!mac) throw invalid();
  // O resultado é decidido DENTRO da transação mas o erro é lançado FORA: se lançasse dentro, o contador de tentativas seria desfeito.
  const outcome = await sequelize.transaction(async (transaction) => {
    const device = await Device.findOne({ where: { mac }, transaction });
    if (!device) return { ok: false };
    const rec = await DeviceAccessKey.findOne({
      where: { deviceId: device.id, usedAt: null, invalidatedAt: null },
      order: [["createdAt", "DESC"]], transaction, lock: transaction.LOCK.UPDATE,
    });
    const r = evaluateKeyAttempt(rec?.toJSON() ?? null, device.id, key, pepper());
    if (r.next && rec) await rec.update(r.next, { transaction });
    await audit({
      actor: { type: "anonymous", ip }, action: "device.key.login", entityType: "device", entityId: device.id,
      result: r.ok ? "success" : "denied", metadata: { mac, reason: r.reason }, transaction,
    });
    if (!r.ok) return { ok: false };
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + env.deviceScopedSessionMinutes * 60_000);
    await DeviceScopedSession.create({ deviceId: device.id, tokenHash: sha256(token), expiresAt, ip, userAgent: (userAgent || "").slice(0, 300) }, { transaction });
    return { ok: true, token, expiresAt, mac };
  });
  if (!outcome.ok) throw invalid();
  return { token: outcome.token, expiresAt: outcome.expiresAt, mac: outcome.mac };
}

/** Middleware: resolve o token da sessão limitada. Só dá acesso ao dispositivo da própria sessão. */
export async function requireDeviceScope(req, _res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const session = token
    ? await DeviceScopedSession.findOne({ where: { tokenHash: sha256(token), revokedAt: null, expiresAt: { [Op.gt]: new Date() } } })
    : null;
  if (!session) throw new AppError(401, "DEVICE_SESSION_INVALID", "Sessão de dispositivo inválida ou expirada. Entre novamente com a chave da TV.");
  const device = await Device.findByPk(session.deviceId);
  if (!device) throw new AppError(401, "DEVICE_SESSION_INVALID", "Sessão de dispositivo inválida ou expirada.");
  req.deviceScope = { session, device };
  next();
}

export const scopeActor = (req) => ({ type: "device_key", id: req.deviceScope.device.id, ip: req.ip, name: "Acesso por chave da TV" });

export async function removeListInScope({ device, actor, reason, activationId }) {
  const activation = await selectLiveActivation(device.id, activationId);
  return removeList({ device, activation, mac: device.mac, actor, reason });
}

export const logoutScope = (session) => session.update({ revokedAt: new Date() });
