import net from "node:net";
import dnsCb from "node:dns";
import http from "node:http";
import https from "node:https";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";

const blocked = () => new AppError(400, "URL_NOT_ALLOWED", "Destino não permitido.");

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && (b === 0 && (c === 0 || c === 2) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    const mapped = v.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    const first = Number.parseInt(v.split(":")[0] || "0", 16);
    const second = Number.parseInt(v.split(":")[1] || "0", 16);
    const isGlobalUnicast = (first & 0xe000) === 0x2000;
    return (
      !isGlobalUnicast ||
      v.startsWith("2001:db8:") ||
      (first === 0x2001 && second <= 0x01ff) ||
      v.startsWith("2002:") ||
      v.startsWith("3fff:")
    );
  }
  return true; // formato desconhecido: bloqueia
}

export function parseHttpUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new AppError(400, "INVALID_URL", "URL inválida.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new AppError(400, "INVALID_URL", "A URL deve usar HTTP ou HTTPS.");
  }
  return url;
}

const hostOf = (url) => url.hostname.replace(/^\[|\]$/g, "");

// Verificação no cadastro da fonte (inclui resolução de DNS).
export async function assertPublicUrl(raw) {
  const url = parseHttpUrl(raw);
  if (env.allowPrivateSources) return url;
  const host = hostOf(url);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") ||
      host.endsWith(".local") || host.endsWith(".home.arpa")) throw blocked();
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw blocked();
    return url;
  }
  const addrs = await dnsCb.promises.lookup(host, { all: true }).catch(() => {
    throw new AppError(400, "URL_UNRESOLVABLE", "Não foi possível resolver o endereço informado.");
  });
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) throw blocked();
  return url;
}

// `lookup` seguro para http.request: valida o IP no momento da conexão (anti DNS-rebinding).
export function safeLookup(hostname, options, callback) {
  const normalizedHost = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!env.allowPrivateSources && (
    normalizedHost === "localhost" ||
    normalizedHost.endsWith(".localhost") ||
    normalizedHost.endsWith(".internal") ||
    normalizedHost.endsWith(".local") ||
    normalizedHost.endsWith(".home.arpa") ||
    (net.isIP(normalizedHost) && isPrivateAddress(normalizedHost))
  )) {
    return callback(blocked());
  }
  dnsCb.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    if (!env.allowPrivateSources && (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address)))) {
      return callback(blocked());
    }
    if (options?.all) return callback(null, addrs);
    return callback(null, addrs[0].address, addrs[0].family);
  });
}

// GET com validação de destino a cada salto (até `maxRedirects`).
export function safeGet(rawUrl, { headers = {}, signal, maxRedirects = 3, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = parseHttpUrl(rawUrl);
      const host = hostOf(url);
      if (!env.allowPrivateSources && net.isIP(host) && isPrivateAddress(host)) throw blocked();
    } catch (e) {
      return reject(e);
    }
    const client = url.protocol === "https:" ? https : http;
    const req = client.get(url, { headers, signal, lookup: safeLookup, timeout: timeoutMs }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (maxRedirects <= 0) return reject(new AppError(502, "TOO_MANY_REDIRECTS", "Redirecionamentos em excesso."));
        const next = new URL(res.headers.location, url).href;
        return safeGet(next, { headers, signal, maxRedirects: maxRedirects - 1, timeoutMs }).then(resolve, reject);
      }
      res.finalUrl = url.href; // URL após os redirects (resolve URIs relativas de playlists HLS)
      return resolve(res);
    });
    req.on("timeout", () => req.destroy(new AppError(504, "ORIGIN_TIMEOUT", "Tempo esgotado ao acessar a origem.")));
    req.on("error", reject);
  });
}
