import { isIP } from "node:net";
import { LoginHistory } from "../../db/models/index.js";

// User-Agent oferece estimativas; navegadores não expõem a identificação física do aparelho.
function describe(ua = "") {
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iOS/iPadOS" : /Windows/i.test(ua) ? "Windows" : /Mac OS X|Macintosh/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "Desconhecido";
  const browser = /Edg\//i.test(ua) ? "Edge" : /OPR\/|Opera/i.test(ua) ? "Opera" : /Firefox\//i.test(ua) ? "Firefox" : /Chrome\//i.test(ua) ? "Chrome" : /Safari\//i.test(ua) ? "Safari" : "Desconhecido";
  const device = /iPad|Tablet/i.test(ua) ? "Tablet" : /Mobile|iPhone|Android/i.test(ua) ? "Celular" : "Computador/outro";
  return { os, browser, device };
}
function publicIp(input) {
  const ip = String(input || "").replace(/^::ffff:/, "");
  if (!isIP(ip)) return null;
  if (ip === "::1" || ip === "0.0.0.0" || ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("169.254.") || ip.startsWith("172.") && Number(ip.split(".")[1]) >= 16 && Number(ip.split(".")[1]) <= 31) return null;
  if (isIP(ip) === 6 && (/^(fc|fd|fe8|fe9|fea|feb)/i.test(ip) || ip === "::")) return null;
  return ip;
}
const ispCache = new Map();
async function lookup(ip) {
  const cached = ispCache.get(ip);
  if (cached && cached.until > Date.now()) return cached.value;
  const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(3500) });
  if (!res.ok) return {};
  const data = await res.json();
  if (data.success === false) return {};
  const value = { isp: String(data.connection?.isp || data.connection?.org || "").slice(0, 160) || null,
    country: String(data.country || "").slice(0, 90) || null,
    region: String(data.region || "").slice(0, 90) || null,
    city: String(data.city || "").slice(0, 90) || null };
  if (ispCache.size > 5000) ispCache.clear();
  ispCache.set(ip, { value, until: Date.now() + 24 * 3600000 });
  return value;
}
// A falha de telemetria nunca deve interromper o login.
export async function recordLogin(user, meta, outcome, reason = null) {
  try {
    const ip = String(meta?.ip || "").slice(0, 64);
    const ua = String(meta?.userAgent || "").slice(0, 500);
    const entry = await LoginHistory.create({ adminUserId: user?.id || null, userEmail: user?.email || null,
      role: user?.role || null, partnerId: user?.partnerId || null, outcome, reason, ip, userAgent: ua, ...describe(ua),
      isp: publicIp(ip) ? null : "Rede local/privada" });
    // Enriquecimento opcional: IP é enviado ao provedor externo somente após login conhecido.
    if (process.env.LOGIN_HISTORY_ISP_LOOKUP !== "false" && publicIp(ip)) {
      void lookup(publicIp(ip)).then((info) => entry.update(info)).catch((e) => console.warn("[login-history:isp]", e.message));
    }
  } catch (e) { console.warn("[login-history]", e.message); }
}
