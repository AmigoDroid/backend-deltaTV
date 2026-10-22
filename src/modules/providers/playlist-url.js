import { AppError } from "../../shared/errors.js";
import { parseHttpUrl } from "../../shared/ssrf.js";

// Padrão Xtream Codes. Aceita {username}/{password} e os apelidos {usuario}/{senha}.
export const DEFAULT_TEMPLATE = "/get.php?username={username}&password={password}&type=m3u_plus&output=m3u8";
const USER_RE = /\{(?:username|usuario)\}/g;
const PASS_RE = /\{(?:password|senha)\}/g;

// A URL base é só a origem (http://host:porta); o caminho fica no template.
export function normalizeBaseUrl(raw) {
  const url = parseHttpUrl(raw);
  if (url.username || url.password) {
    throw new AppError(422, "INVALID_BASE_URL", "A URL base não deve conter usuário ou senha.");
  }
  return url.origin;
}

/**
 * Monta a URL da playlist do usuário. Usuário/senha são codificados (encodeURIComponent), e a URL final
 * precisa permanecer na MESMA origem da base (impede que um template desvie a requisição para outro host).
 */
export function buildPlaylistUrl(baseUrl, template, { username, password }) {
  const filled = template
    .replace(USER_RE, () => encodeURIComponent(username))
    .replace(PASS_RE, () => encodeURIComponent(password));
  const base = new URL(baseUrl);
  const url = new URL(filled, base);
  if (url.origin !== base.origin) {
    throw new AppError(422, "INVALID_TEMPLATE", "O template desvia para outro endereço.");
  }
  return url.href;
}

export function validateTemplate(template, baseUrl = "http://exemplo.invalid") {
  if (typeof template !== "string" || template.length > 500 || /\s/.test(template)) {
    throw new AppError(422, "INVALID_TEMPLATE", "Template inválido (sem espaços, até 500 caracteres).");
  }
  if (!template.startsWith("/")) throw new AppError(422, "INVALID_TEMPLATE", "O template deve começar com '/'.");
  if (!USER_RE.test(template) || !PASS_RE.test(template)) {
    USER_RE.lastIndex = 0; PASS_RE.lastIndex = 0;
    throw new AppError(422, "INVALID_TEMPLATE", "O template deve conter {username} e {password}.");
  }
  USER_RE.lastIndex = 0; PASS_RE.lastIndex = 0;
  buildPlaylistUrl(baseUrl, template, { username: "u", password: "p" }); // lança se desviar de origem
}
