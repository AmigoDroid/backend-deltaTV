import crypto from "node:crypto";
import { hmacHex } from "../../shared/crypto.js";

/**
 * URLs assinadas de curta duração, quando o servidor de ORIGEM suporta validação de assinatura.
 * Tipos suportados (a origem precisa implementar a verificação correspondente):
 *  - hmac-query:        ?expires=<epoch>&token=hex(HMAC-SHA256(secret, path + expires))
 *  - nginx-secure-link: ?md5=base64url(MD5("<expires><path> <secret>"))&expires=<epoch>   (módulo secure_link do nginx)
 * Sem suporte da origem ("none"), o bloqueio só impede novas URLs; a URL já entregue vale até a origem revogá-la.
 */
export function signOriginUrl(rawUrl, signing, secret, nowSec = Math.floor(Date.now() / 1000)) {
  const type = signing?.type ?? "none";
  if (type === "none") return rawUrl;
  const url = new URL(rawUrl);
  const expires = nowSec + (signing.ttlSeconds ?? 60);
  if (type === "hmac-query") {
    url.searchParams.set(signing.expiresParam || "expires", String(expires));
    url.searchParams.set(signing.tokenParam || "token", hmacHex(secret, `${url.pathname}${expires}`));
  } else if (type === "nginx-secure-link") {
    const md5 = crypto.createHash("md5").update(`${expires}${url.pathname} ${secret}`).digest("base64url");
    url.searchParams.set("md5", md5);
    url.searchParams.set("expires", String(expires));
  } else {
    throw new Error(`Tipo de assinatura desconhecido: ${type}`);
  }
  return url.toString();
}
