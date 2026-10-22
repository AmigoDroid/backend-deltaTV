import { normalizeMac } from "../../shared/mac.js";
import { AppError } from "../../shared/errors.js";

/**
 * Contrato de identidade multiplataforma (v1.1).
 *
 * Plataformas: roku | android | tizen | webos | web.
 * Tipos de identificador:
 *   virtual_mac   — Roku legado: MAC virtual derivado do ID do aparelho (+ installationId "roku-<MAC>").
 *   install_uuid  — UUID v4 gerado pelo app na primeira execução e guardado em armazenamento privado do app.
 *   platform_hash — hash SHA-256 (hex) de um identificador oferecido pela plataforma. O cliente NUNCA envia o ID cru.
 *
 * Nenhum desses identificadores é prova de autorização: quem autoriza é o backend (ativação, sessão, licença).
 * MAC físico não é exigido fora do Roku.
 */

export const PLATFORMS = Object.freeze(["roku", "android", "tizen", "webos", "web"]);
export const IDENTIFIER_TYPES = Object.freeze(["virtual_mac", "install_uuid", "platform_hash"]);

const APP_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const ZERO_UUID = "00000000-0000-4000-8000-000000000000";

const bad = (code, message) => new AppError(400, code, message);

/** installationId legado do Roku: "roku-" + MAC sem separadores, em maiúsculas. */
export const legacyRokuInstallationId = (mac) => `roku-${mac.replaceAll(":", "")}`;

/**
 * Normaliza e valida a identidade enviada por um cliente.
 * @returns {{platform,appId,identifierType,deviceKey,mac:(string|null),installationId:(string|null),legacy:boolean}}
 *  deviceKey: chave única e estável (plataforma + app + identificador) usada para localizar o dispositivo.
 */
export function normalizeIdentity(input) {
  const i = input ?? {};
  const platform = String(i.platform ?? "").toLowerCase();
  if (!PLATFORMS.includes(platform)) throw bad("INVALID_PLATFORM", "Plataforma não suportada.");

  const appId = String(i.appId ?? `delta-tv-${platform}`).toLowerCase();
  if (!APP_ID.test(appId)) throw bad("INVALID_APP_ID", "Identificador de aplicativo inválido.");

  if (platform === "roku") {
    const mac = normalizeMac(i.mac);
    if (!mac) throw bad("INVALID_MAC", "Endereço MAC inválido.");
    const expected = legacyRokuInstallationId(mac);
    if (i.installationId !== undefined && i.installationId !== expected) {
      throw bad("INSTALLATION_ID_MISMATCH", "O identificador deve ser roku- seguido do MAC sem separadores, em maiúsculas.");
    }
    return { platform, appId, identifierType: "virtual_mac", deviceKey: `roku:${mac}`, mac, installationId: expected, legacy: true };
  }

  const identifierType = String(i.identifierType ?? "install_uuid");
  if (identifierType === "virtual_mac") throw bad("INVALID_IDENTIFIER_TYPE", "virtual_mac só é válido na plataforma Roku.");
  if (!IDENTIFIER_TYPES.includes(identifierType)) throw bad("INVALID_IDENTIFIER_TYPE", "Tipo de identificador inválido.");

  const raw = String(i.identifier ?? "");
  let identifier;
  if (identifierType === "install_uuid") {
    if (!UUID_V4.test(raw) || raw === ZERO_UUID) throw bad("INVALID_IDENTIFIER", "Identificador de instalação inválido.");
    identifier = raw.toLowerCase();
  } else {
    if (!SHA256_HEX.test(raw) || /^0+$/.test(raw)) throw bad("INVALID_IDENTIFIER", "Identificador de plataforma inválido (envie o hash SHA-256).");
    identifier = raw.toLowerCase();
  }
  return { platform, appId, identifierType, deviceKey: `${platform}:${appId}:${identifier}`, mac: null, installationId: identifier, legacy: false };
}

/** Rótulo curto para telas e suporte (nunca o identificador inteiro). */
export function displayIdentifier(identity) {
  if (identity.mac) return identity.mac;
  const id = identity.installationId ?? "";
  return `${identity.platform.toUpperCase()}-${id.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}
