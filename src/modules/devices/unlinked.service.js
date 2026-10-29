import { Op } from "sequelize";
import { sequelize, Activation, Device, DevicePairingToken } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { macSearchSql, normalizeMac } from "../../shared/mac.js";
import { pageOf, paged } from "../../shared/pagination.js";
import { legacyRokuInstallationId } from "./device-identity.js";
import { configureDeviceByAdmin } from "./registration.service.js";
import { presenceOf } from "./presence.js";

/**
 * Dispositivos SEM VÍNCULO.
 *
 * O app, ao abrir, chama POST /client/register (registration.service.registerDevice): o servidor cria o Device e, como ele
 * ainda não tem ativação, ele passa a aparecer aqui. "Sem vínculo" = nenhuma ativação viva (ativa ou bloqueada) COM LISTA — vale
 * para o aparelho novo, para o que teve a lista removida (ativação revogada) e para o que tem só a licença ativada, sem lista
 * própria nem parceiro/provedor (nada para tocar). Lista = ativação de parceria ou lista própria (URL) na licença.
 * Ativação bloqueada com lista continua "vinculada" (o bloqueio é decisão do painel). O administrador então informa código,
 * usuário e senha do provedor; a validação e a ativação reaproveitam configureDeviceByAdmin (mesmas regras do restante).
 */

// "Device" é o alias que o Sequelize dá à tabela nas consultas deste model.
// "Tem lista" = ativação de parceria (qualquer uma, inclusive de cadastro antigo sem provedor definido: não some do painel de dispositivos)
// ou licença com lista própria. Só a licença SEM lista própria e sem parceria passa a contar como sem vínculo.
export const HAS_LIST_SQL = `(a.partner_id IS NOT NULL OR (a.license_id IS NOT NULL AND a.playlist_url_enc IS NOT NULL))`;
export const NOT_LINKED_SQL = `NOT EXISTS (SELECT 1 FROM activations a WHERE a.device_id = "Device".id AND a.status <> 'revoked' AND ${HAS_LIST_SQL})`;
const notLinked = () => sequelize.literal(NOT_LINKED_SQL);

export const countUnlinkedDevices = () => Device.count({ where: { [Op.and]: [notLinked()] } });

const serialize = (device, lastRevoked, waiting) => ({
  id: device.id,
  mac: device.mac,
  platform: device.platform,
  installationId: device.lastInstallationId,
  firstSeenAt: device.firstRegisteredAt ?? device.createdAt,
  ...presenceOf(device.id, device.lastSeenAt), // { online, lastSeenAt }
  // A TV está com um pareamento aberto agora (exibindo o QR / aguardando configuração).
  waiting,
  // Já teve lista e ela foi removida (pelo admin, revendedor ou pelo próprio aparelho).
  previouslyLinked: !!lastRevoked,
  lastUnlinkedAt: lastRevoked ? (lastRevoked.revokedAt ?? lastRevoked.updatedAt) : null,
  lastUnlinkReason: lastRevoked?.statusReason ?? null,
});

export async function listUnlinkedDevices({ q, page, pageSize }) {
  const and = [notLinked()];
  if (q) and.push(sequelize.literal(macSearchSql("Device", q, (v) => sequelize.escape(v))));

  const { rows, count } = await Device.findAndCountAll({
    where: { [Op.and]: and },
    // Mais recentemente ativos primeiro: o aparelho que acabou de abrir o app fica no topo.
    order: [[sequelize.literal(`COALESCE("Device"."last_seen_at", "Device"."created_at")`), "DESC"]],
    ...pageOf({ page, pageSize }),
  });

  const ids = rows.map((d) => d.id);
  const [revoked, pairings] = ids.length
    ? await Promise.all([
      Activation.findAll({ where: { deviceId: { [Op.in]: ids }, status: "revoked" }, attributes: ["deviceId", "revokedAt", "statusReason", "updatedAt"] }),
      DevicePairingToken.findAll({
        where: { deviceId: { [Op.in]: ids }, usedAt: null, registrationUsedAt: null, expiresAt: { [Op.gt]: new Date() } },
        attributes: ["deviceId"],
      }),
    ])
    : [[], []];

  // A remoção mais recente de cada aparelho.
  const when = (a) => new Date(a.revokedAt ?? a.updatedAt ?? 0).getTime();
  const lastByDevice = new Map();
  for (const a of revoked) {
    const prev = lastByDevice.get(a.deviceId);
    if (!prev || when(a) > when(prev)) lastByDevice.set(a.deviceId, a);
  }
  const waiting = new Set(pairings.map((p) => p.deviceId));

  return paged(rows.map((d) => serialize(d, lastByDevice.get(d.id), waiting.has(d.id))), count, { page, pageSize });
}

async function assertUnlinked(device) {
  // Só conta como vinculado quem tem lista; licença sem lista ainda pode receber parceiro pelo painel.
  const [[{ n }]] = await sequelize.query(
    `SELECT count(*)::int AS n FROM activations a WHERE a.device_id = :id AND a.status <> 'revoked' AND ${HAS_LIST_SQL}`,
    { replacements: { id: device.id } },
  );
  if (n > 0) {
    throw new AppError(409, "DEVICE_ALREADY_LINKED", "Este dispositivo já está vinculado a uma lista. Para atualizar essa lista ou adicionar outro parceiro ao mesmo MAC, use “Adicionar parceiro” na tela de Dispositivos.");
  }
}

const partnerConfiguration = ({ code, username, password }) => ({ mode: "partner", confirm: true, code, username, password });

/**
 * Cadastra um dispositivo direto pelo painel: MAC + código + usuário + senha. O aparelho pode nunca ter aberto o app —
 * o registro é criado aqui e, quando a TV abrir o app, ela recupera o acesso pelo MAC (mesmo caminho de reinstalação).
 * Um MAC pode ter VÁRIOS parceiros: se o MAC já tem lista, o parceiro informado é ADICIONADO (as listas dos outros parceiros ficam
 * intactas); se esse parceiro já está no MAC, o acesso dele é atualizado (regra de configureDeviceByAdmin). Se o aparelho foi criado agora e a ativação
 * falha (senha errada, provedor fora do ar...), o registro é descartado para não deixar lixo na lista de "sem vínculo".
 */
export async function registerDeviceFromPanel({ mac: macInput, ...credentials }, actor) {
  const mac = normalizeMac(macInput);
  if (!mac) throw new AppError(400, "INVALID_MAC", "Endereço MAC inválido.");

  const [device, created] = await Device.findOrCreate({
    where: { mac },
    defaults: { mac, lastInstallationId: legacyRokuInstallationId(mac) },
  });

  let state;
  try {
    state = await configureDeviceByAdmin(device.id, partnerConfiguration(credentials), actor);
  } catch (e) {
    if (created) await discardIfUnused(device.id);
    throw e;
  }
  await audit({ actor, action: "device.register.admin", entityType: "device", entityId: device.id, metadata: { mac, created } });
  return { created, ...state };
}

/** Vincula um dispositivo que já está na lista de "sem vínculo" (o administrador clicou nele e informou os dados). */
export async function linkUnlinkedDevice(deviceId, credentials, actor) {
  const device = await Device.findByPk(deviceId);
  if (!device) throw notFound("Dispositivo");
  await assertUnlinked(device);
  return configureDeviceByAdmin(device.id, partnerConfiguration(credentials), actor);
}

/** Exclui um dispositivo que nunca teve vínculo (ex.: MAC digitado errado ou lixo). Quem já teve ativação mantém o histórico. */
export async function removeUnlinkedDevice(deviceId, actor) {
  const device = await Device.findByPk(deviceId);
  if (!device) throw notFound("Dispositivo");
  if ((await Activation.count({ where: { deviceId: device.id } })) > 0) {
    throw new AppError(409, "DEVICE_HAS_HISTORY", "Este dispositivo já teve vínculo e mantém histórico; não pode ser excluído.");
  }
  await sequelize.transaction(async (transaction) => {
    // Pareamentos, chaves e sessões do aparelho saem junto (ON DELETE CASCADE).
    await device.destroy({ transaction });
    await audit({ actor, action: "device.delete", entityType: "device", entityId: device.id, metadata: { mac: device.mac }, transaction });
  });
}

async function discardIfUnused(deviceId) {
  try {
    if ((await Activation.count({ where: { deviceId } })) === 0) await Device.destroy({ where: { id: deviceId } });
  } catch {
    /* melhor esforço: no pior caso o aparelho só continua listado como "sem vínculo" */
  }
}
