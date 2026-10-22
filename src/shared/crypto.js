import crypto from "node:crypto";
import { promisify } from "node:util";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";

const scrypt = promisify(crypto.scrypt);
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (sem I, L, O, U)

/* ---------- Códigos de licença / parceria ---------- */

// 20 caracteres aleatórios (100 bits) via CSPRNG: não previsível.
export function generateCode(prefix) {
  let raw = "";
  for (let i = 0; i < 20; i++) raw += ALPHABET[crypto.randomInt(32)];
  return `${prefix}-${raw.match(/.{5}/g).join("-")}`;
}

export const normalizeCode = (code) =>
  typeof code === "string" ? code.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";

// O banco guarda apenas HMAC(code, pepper): um vazamento do banco não revela códigos.
export function hashCode(code) {
  return crypto.createHmac("sha256", env.codePepper).update(normalizeCode(code)).digest("hex");
}

/* ---------- Senhas (scrypt) ---------- */

const SCRYPT = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split("$");
    if (alg !== "scrypt") return false;
    const expected = Buffer.from(hash, "base64");
    const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/* ---------- JWT HS256 (access tokens) ---------- */

const b64u = (input) => Buffer.from(input).toString("base64url");
const sign = (data) => crypto.createHmac("sha256", env.jwtSecret).update(data).digest();

export function signJwt(payload, ttlSeconds, { iat } = {}) {
  const now = iat ?? Math.floor(Date.now() / 1000); // `iat` fixo = token determinístico (ver mirrorTokenFor)
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  return `${head}.${body}.${sign(`${head}.${body}`).toString("base64url")}`;
}

export function verifyJwt(token, expectedTyp, { graceSeconds = 0 } = {}) {
  const invalid = () => new AppError(401, "INVALID_TOKEN", "Token inválido ou expirado.");
  if (typeof token !== "string") throw invalid();
  const parts = token.split(".");
  if (parts.length !== 3) throw invalid();
  const [head, body, sig] = parts;
  const expected = sign(`${head}.${body}`);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw invalid();
  let payload;
  try {
    const header = JSON.parse(Buffer.from(head, "base64url").toString());
    if (header.alg !== "HS256") throw invalid();
    payload = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    throw invalid();
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000) - graceSeconds) throw invalid();
  if (expectedTyp && payload.typ !== expectedTyp) throw invalid();
  return payload;
}

/* ---------- Tokens opacos (refresh) ---------- */

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/* ---------- Cifra de segredos em repouso (AES-256-GCM) ---------- */

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", env.encryptionKey, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(blob) {
  const [v, iv, tag, ct] = String(blob).split(".");
  if (v !== "v1") throw new Error("Formato de segredo desconhecido.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", env.encryptionKey, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export function hmacHex(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), "hex");
  const y = Buffer.from(String(b), "hex");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
