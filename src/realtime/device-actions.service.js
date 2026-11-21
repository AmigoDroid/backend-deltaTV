/** Operações exclusivas da sessão de uma TV pelo WSS autenticado.
 * O socket não recebe URL arbitrária: cada operação reutiliza as validações do backend.
 */
import { Activation, DeviceSession } from '../db/models/index.js';
import { verifyJwt } from '../shared/crypto.js';
import { listsOfDevice } from '../modules/devices/registration.service.js';
import { issueSiblingSession } from '../modules/activations/activation.service.js';
import { requestDeviceFailover } from '../modules/provider-monitor/device-failover.service.js';
import { claimRemoteCommands, acknowledgeRemoteCommand } from './remote-control.service.js';
import { noticeForActivation } from '../modules/clients/expiry-notice.service.js';
import { checkActivation, denialError } from '../modules/access/access.service.js';
import { xtreamConfigFor } from '../modules/xtream/xtream.service.js';
import { statusOf } from '../modules/activations/client-status.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LISTS = 16;
const isIdList = value => Array.isArray(value) && value.length <= 30 && value.every(v => typeof v === 'string' && uuid.test(v));
const installationPattern = /^[A-Za-z0-9._:-]{8,100}$/;

async function assertSession(peer) {
  const row = await DeviceSession.findByPk(peer.sessionId, { attributes: ['activationId', 'revokedAt', 'expiresAt'], raw: true });
  if (!row || String(row.activationId) !== String(peer.activationId) || row.revokedAt || new Date(row.expiresAt) <= new Date()) {
    const error = new Error('Session expired'); error.status = 401; error.code = 'SESSION_EXPIRED'; throw error;
  }
}

// FormatJson do BrightScript pode enviar chaves de objetos inteiramente minúsculas.
export function normalizeDeviceAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  return {
    ...input,
    knownIds: input.knownIds ?? input.knownids,
    ignoredIds: input.ignoredIds ?? input.ignoredids,
    installationId: input.installationId ?? input.installationid,
    accessToken: input.accessToken ?? input.accesstoken,
    commandId: input.commandId ?? input.commandid,
    targetActivationId: input.targetActivationId ?? input.targetactivationid,
    errorCode: input.errorCode ?? input.errorcode,
  };
}

export function validDeviceAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (input.type === 'lists-sync') {
    return isIdList(input.knownIds) && isIdList(input.ignoredIds) &&
      Number.isInteger(input.slots) && input.slots >= 0 && input.slots <= MAX_LISTS &&
      typeof input.installationId === 'string' && installationPattern.test(input.installationId) &&
      typeof input.accessToken === 'string' && input.accessToken.length >= 20 && input.accessToken.length <= 4096;
  }
  if (input.type === 'route-get' || input.type === 'status-get') {
    return typeof input.accessToken === 'string' && input.accessToken.length >= 20 && input.accessToken.length <= 4096;
  }
  if (input.type === 'action') {
    if (input.action === 'failover') return true;
    if (input.action === 'switch') {
      return typeof input.targetActivationId === 'string' && uuid.test(input.targetActivationId) &&
        typeof input.accessToken === 'string' && input.accessToken.length >= 20 && input.accessToken.length <= 4096 &&
        typeof input.installationId === 'string' && installationPattern.test(input.installationId);
    }
    if (input.action !== 'ack') return false;
    return typeof input.commandId === 'string' && uuid.test(input.commandId) &&
      ['executed','failed','refused'].includes(input.status) &&
      (input.errorCode === undefined || (typeof input.errorCode === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input.errorCode))) &&
      (input.result === undefined || (input.result && typeof input.result === 'object' && !Array.isArray(input.result)));
  }
  return input.type === 'commands-get' || input.type === 'expiry-get';
}

async function assertDeviceToken(peer, token) {
  await assertSession(peer);
  const claims = verifyJwt(token, 'device');
  if (String(claims.sid) !== String(peer.sessionId) || String(claims.aid) !== String(peer.activationId)) {
    const error = new Error('Device token mismatch'); error.status = 403; error.code = 'SESSION_MISMATCH'; throw error;
  }
}

export async function syncDeviceLists(peer, input, ip) {
  await assertDeviceToken(peer, input.accessToken);
  const known = new Set(input.knownIds);
  const ignored = new Set(input.ignoredIds);
  const rows = await listsOfDevice(peer.deviceId);
  const current = await Activation.findByPk(peer.activationId);
  if (!current || String(current.deviceId) !== String(peer.deviceId) || current.status === 'revoked') throw new Error('Session is no longer valid');
  let slots = input.slots;
  const lists = [];
  for (const row of rows) {
    const item = { activationId: row.activationId, kind: row.kind, status: row.status, listName: row.listName,
      allowed: row.allowed === true, configured: row.configured === true, accessToken: '', refreshToken: '' };
    if (!known.has(String(item.activationId)) && !ignored.has(String(item.activationId)) && item.allowed && item.configured && slots > 0) {
      try {
        const r = await issueSiblingSession({ currentActivation: current, targetActivationId: item.activationId,
          installationId: input.installationId, meta: { ip, userAgent: 'DeltaTV Roku WSS' } });
        item.accessToken = r.session.accessToken;
        item.refreshToken = r.session.refreshToken;
        slots--;
      } catch { /* Lista removida ou indisponível enquanto o servidor atendia o pedido. */ }
    }
    lists.push(item);
  }
  return { ok: true, serverIds: lists.map(x => x.activationId), lists };
}

export async function executeDeviceAction(peer, input) {
  await assertSession(peer);
  if (input.type === 'status-get') {
    await assertDeviceToken(peer, input.accessToken);
    const { activation, decision } = await checkActivation(peer.activationId);
    return { type: 'status-result', data: statusOf(activation, decision) };
  }
  if (input.type === 'route-get') {
    await assertDeviceToken(peer, input.accessToken);
    const { activation, decision } = await checkActivation(peer.activationId);
    if (!decision.allowed) throw denialError(decision);
    return { type: 'route-result', data: { ...(await xtreamConfigFor(activation, {sessionId: peer.sessionId})), expiresAt: decision.expiresAt } };
  }
  if (input.type === 'commands-get') return { type: 'remote-commands', commands: await claimRemoteCommands(peer.activationId, 'wss') };
  if (input.type === 'expiry-get') {
    const notice = await noticeForActivation(peer.activationId, peer.launchId || undefined);
    return { type: 'expiry-result', ...notice };
  }
  if (input.type === 'action' && input.action === 'switch') {
    await assertDeviceToken(peer, input.accessToken);
    const currentActivation = await Activation.findByPk(peer.activationId);
    const r = await issueSiblingSession({currentActivation, targetActivationId: input.targetActivationId,
      installationId: input.installationId, meta: {userAgent: 'DeltaTV Roku WSS'}});
    return {type: 'action-result', action: 'switch', result: {ok: true, activationId: r.activation.id,
      kind: r.activation.licenseId ? 'license' : 'partner', tokens: {accessToken: r.session.accessToken,
        refreshToken: r.session.refreshToken, expiresIn: r.session.expiresIn}}};
  }
  if (input.type === 'action' && input.action === 'failover') {
    return { type: 'action-result', action: 'failover', result: await requestDeviceFailover(peer.activationId) };
  }
  if (input.type === 'action' && input.action === 'ack') {
    return { type: 'action-result', action: 'ack', commandId: input.commandId,
      result: await acknowledgeRemoteCommand({ id: input.commandId, activationId: peer.activationId,
        status: input.status, errorCode: input.errorCode || null, result: input.result || null }) };
  }
  throw new Error('Unsupported action');
}
