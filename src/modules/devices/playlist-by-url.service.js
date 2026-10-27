import { Op } from "sequelize";
import { sequelize, Activation, Device } from "../../db/models/index.js";
import { AppError } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { normalizeMac } from "../../shared/mac.js";
import { encryptSecret } from "../../shared/crypto.js";
import { assertPublicUrl } from "../../shared/ssrf.js";
import { checkActivation } from "../access/access.service.js";
import { probeAccount, xtreamFromUrl } from "../xtream/xtream.service.js";
import { dropMirrorAuth } from "../mirror/mirror.cache.js";

/**
 * Cadastro de lista pelo LINK M3U (site público, rota /upload/playlist).
 *
 * O servidor NÃO baixa a lista: só lê servidor + usuário + senha do link e guarda uma URL Xtream canônica (cifrada).
 * A TV usa o fluxo de sempre (xtreamConfigFor -> player_api.php) e mostra o NOME informado pelo cliente.
 *
 *  - MAC com licença individual (ativação "sem parceiro"): grava na ativação; a TV já passa a usar.
 *  - MAC sem licença: aceita e guarda no dispositivo (pending_playlist_*); nada é entregue até a licença ser ativada,
 *    quando applyPendingPlaylist() move a lista para a ativação.
 */

const live = { [Op.ne]: "revoked" };
const MAX_CRED = 128;

/** Servidor + usuário + senha a partir do link da lista (formatos Xtream). Lança 422 se não der para extrair. */
export function parseListUrl(raw) {
  const cred = xtreamFromUrl(typeof raw === "string" ? raw.trim() : "");
  if (!cred || !cred.username || !cred.password) {
    throw new AppError(
      422,
      "NOT_XTREAM_LIST",
      "Não encontramos servidor, usuário e senha neste link. Cole o link M3U completo que seu provedor enviou (algo como http://servidor/get.php?username=…&password=…).",
    );
  }
  if (cred.username.length > MAX_CRED || cred.password.length > MAX_CRED) {
    throw new AppError(422, "NOT_XTREAM_LIST", "Usuário ou senha do link são longos demais.");
  }
  return cred;
}

/** URL canônica guardada no banco (xtreamFromUrl a lê de volta). Descarta caminho, porta de proxy e parâmetros extras do link original. */
export const canonicalListUrl = ({ baseUrl, username, password }) =>
  `${baseUrl}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&type=m3u_plus&output=m3u8`;

/**
 * Se o dispositivo tem lista pendente e a ativação (licença individual) ainda não tem lista, move a pendente para ela.
 * Chamar DENTRO da transação que cria/reaproveita a ativação por licença.
 */
export async function applyPendingPlaylist(activation, transaction) {
  if (!activation || activation.partnerId || activation.playlistUrlEnc) return false;
  const device = await Device.findByPk(activation.deviceId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!device?.pendingPlaylistUrlEnc) return false;
  await activation.update(
    { playlistName: device.pendingPlaylistName, playlistUrlEnc: device.pendingPlaylistUrlEnc },
    { transaction },
  );
  await device.update({ pendingPlaylistName: null, pendingPlaylistUrlEnc: null, pendingPlaylistAt: null }, { transaction });
  await audit({
    actor: { type: "system", id: null }, action: "device.playlist.pending_applied", entityType: "activation", entityId: activation.id,
    metadata: { mac: activation.mac, listName: activation.playlistName }, transaction,
  });
  return true;
}

export async function addListByUrl({ mac: macInput, name, url, ip }) {
  const mac = normalizeMac(macInput);
  if (!mac) throw new AppError(400, "INVALID_MAC", "MAC inválido. Use os 12 caracteres que aparecem na tela do DeltaTV.");
  const listName = String(name ?? "").trim();
  if (!listName || listName.length > 160) throw new AppError(400, "INVALID_NAME", "Informe um nome de até 160 caracteres.");

  const cred = parseListUrl(url);
  await assertPublicUrl(cred.baseUrl); // anti-SSRF: só servidores públicos
  const device = await Device.findOne({ where: { mac }, attributes: ["id"] });
  if (!device) {
    throw new AppError(404, "DEVICE_NOT_FOUND", "Não encontramos esta TV. Abra o DeltaTV nela e confira o MAC na tela inicial.");
  }

  // Confere no provedor se a conta existe. Só a recusa DEFINITIVA bloqueia; rede/WAF não provam nada (a TV alcança o painel).
  const probe = await probeAccount(cred);
  if (!probe.ok && probe.reason === "invalid") {
    throw new AppError(
      422,
      "PROVIDER_ACCOUNT_INVALID",
      probe.status ? `O provedor informou que esta conta está ${probe.status}.` : "O provedor recusou o usuário e a senha deste link. Confira se o link está completo e atualizado.",
    );
  }

  const urlEnc = encryptSecret(canonicalListUrl(cred));
  const host = new URL(cred.baseUrl).hostname;

  const out = await sequelize.transaction(async (transaction) => {
    // Trava o dispositivo: serializa com a ativação de licença (applyPendingPlaylist) e evita lista "esquecida" como pendente.
    const locked = await Device.findByPk(device.id, { transaction, lock: transaction.LOCK.UPDATE });
    const standalone = await Activation.findOne({
      where: { deviceId: locked.id, partnerId: null, licenseId: { [Op.ne]: null }, status: live },
      transaction, // sem lock de linha aqui: o lock do dispositivo já serializa com a ativação por licença (mesma ordem de travas)
    });

    if (standalone) {
      const created = !standalone.playlistUrlEnc;
      await standalone.update({ playlistName: listName, playlistUrlEnc: urlEnc }, { transaction });
      await locked.update({ pendingPlaylistName: null, pendingPlaylistUrlEnc: null, pendingPlaylistAt: null }, { transaction });
      const { decision } = await checkActivation(standalone.id, { transaction });
      await audit({
        actor: { type: "anonymous", id: null, ip }, action: "device.playlist.by_url", entityType: "activation", entityId: standalone.id,
        metadata: { mac, listName, host, licensed: !!decision.allowed, created }, transaction,
      });
      return { activationId: standalone.id, created, licensed: !!decision.allowed, code: decision.allowed ? "OK" : decision.code };
    }

    const created = !locked.pendingPlaylistUrlEnc;
    await locked.update({ pendingPlaylistName: listName, pendingPlaylistUrlEnc: urlEnc, pendingPlaylistAt: new Date() }, { transaction });
    await audit({
      actor: { type: "anonymous", id: null, ip }, action: "device.playlist.by_url_pending", entityType: "device", entityId: locked.id,
      metadata: { mac, listName, host, created }, transaction,
    });
    return { activationId: null, created, licensed: false, code: "NO_LICENSE" };
  });

  if (out.activationId) dropMirrorAuth(out.activationId);
  return { mac, listName, host, created: out.created, licensed: out.licensed, code: out.code, accountChecked: probe.ok };
}
