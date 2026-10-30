// Cliente da API. Tokens de acesso são curtos; o refresh é rotacionado a cada uso.
// A autorização real acontece no backend: esconder botões aqui é só conveniência de UI.
const API = import.meta.env.VITE_API_URL || "http://localhost:3000";
const KEY = "iptv-admin-auth";

let auth = (() => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } })();
const save = (a) => {
  auth = a;
  if (a) localStorage.setItem(KEY, JSON.stringify(a)); else localStorage.removeItem(KEY);
  window.dispatchEvent(new Event("auth-changed"));
};
export const getAuth = () => auth;

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.message || "Não foi possível concluir a operação.");
    this.status = status;
    this.code = data?.code;
    this.details = data?.details;
  }
}

async function raw(path, { method = "GET", body, query, token } = {}) {
  const url = new URL(`${API}/api/v1${path}`);
  Object.entries(query || {}).forEach(([k, v]) => { if (v !== "" && v != null) url.searchParams.set(k, v); });
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch só rejeita por falha de rede/CORS: a mensagem padrão do navegador ("Failed to fetch") não ajuda ninguém.
    throw new ApiError(0, { code: "NETWORK", message: "Não foi possível conectar ao servidor. Verifique a conexão e tente novamente." });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

let refreshing = null;
async function refresh() {
  const data = await raw("/auth/refresh", { method: "POST", body: { refreshToken: auth.refreshToken } });
  save({ accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user });
}

export async function api(path, opts = {}, retry = true) {
  try {
    return await raw(path, { ...opts, token: auth?.accessToken });
  } catch (e) {
    // Só renova a sessão quando o problema é o token de acesso (INVALID_TOKEN). Outros 401 — como "código, usuário ou senha
    // inválidos" ao vincular um dispositivo — são respostas normais da operação: renovar e repetir a chamada reenviaria as
    // credenciais do cliente ao provedor à toa e ainda poderia deslogar o administrador se a renovação falhasse.
    if (e.status === 401 && e.code === "INVALID_TOKEN" && retry && auth?.refreshToken) {
      try {
        await (refreshing ??= refresh().finally(() => { refreshing = null; }));
      } catch {
        save(null);
        throw e;
      }
      return api(path, opts, false);
    }
    throw e;
  }
}

export async function login(email, password) {
  const d = await raw("/auth/login", { method: "POST", body: { email, password, audience: "admin" } });
  save({ accessToken: d.accessToken, refreshToken: d.refreshToken, user: d.user });
}
export async function logout() {
  const t = auth?.refreshToken;
  save(null);
  if (t) await raw("/auth/logout", { method: "POST", body: { refreshToken: t } }).catch(() => {});
}

// Acesso por MAC + chave de 6 dígitos (/device-access). O token dessa sessão é limitado a UM dispositivo e fica só em memória
// (nunca em localStorage): fechar a aba encerra o acesso.
export async function deviceApi(path, { method = "GET", body, token } = {}) {
  const res = await fetch(new URL(`${API}/api/v1/device-access${path}`), {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
