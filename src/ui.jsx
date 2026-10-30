import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api.js";

/* ---------- Formatação (UTC no banco; exibição em America/Sao_Paulo) ---------- */
export const fmtDate = (v) => (v ? new Date(v).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—");
export const fmtDateTime = (v) =>
  v ? new Date(v).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "—";
/** "há 5 s", "há 3 min", "há 2 h", "há 4 d" — para a última atividade. */
export function fmtAgo(v, now = Date.now()) {
  if (!v) return "nunca";
  const s = Math.max(0, Math.round((now - new Date(v).getTime()) / 1000));
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} d`;
}
export const fmtMoney = (cents) =>
  (Number(cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
/**
 * Valor em reais digitado -> centavos. Aceita "10", "10,5", "10.50", "1.234,56", "R$ 1.234,56". Devolve null se não for número
 * (antes virava NaN -> null no JSON, e "1.234,56" não era entendido).
 */
export function toCents(input) {
  let s = String(input ?? "").replace(/R\$|\s/g, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");          // 1.234,56 -> 1234.56
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");        // 1.234 (milhar) -> 1234
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}
// Datas de calendário no fuso de São Paulo (UTC-3 fixo desde 2019), o mesmo usado na exibição (fmtDate).
const SP_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });
export const dateInput = (v) => (v ? SP_DATE.format(new Date(v)) : "");
/** "2026-10-20" -> instante em São Paulo: início do dia, ou fim do dia (para "válido até"). */
export const spDateToIso = (ymd, endOfDay = false) => new Date(`${ymd}T${endOfDay ? "23:59:59" : "00:00:00"}-03:00`).toISOString();
/** "aabbccddeeff" / "AA-BB-..." -> "AA:BB:CC:DD:EE:FF" (ou null se não tiver 12 dígitos hexadecimais). */
export function formatMac(v) {
  const hex = String(v ?? "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
  return hex.length === 12 ? hex.match(/.{2}/g).join(":") : null;
}

const STATUS = {
  online: ["Online", "ok"], offline: ["Offline", "muted"],
  active: ["Ativa", "ok"], pending: ["Pendente", "info"], expired: ["Expirada", "warn"], suspended: ["Suspensa", "warn"],
  blocked: ["Bloqueada", "bad"], cancelled: ["Cancelada", "muted"], revoked: ["Removida", "muted"],
  open: ["Em aberto", "info"], partial: ["Parcial", "warn"], paid: ["Paga", "ok"], overdue: ["Vencida", "bad"],
  success: ["Sucesso", "ok"], failure: ["Falha", "bad"], denied: ["Negado", "warn"], disabled: ["Desativada", "muted"],
  proxy: ["Proxy", "info"], redirect: ["Redirect", "muted"],
  review: ["Em conferência", "warn"], refunded: ["Devolvido", "muted"], failed: ["Falhou", "bad"],
};
// Status que o usuário precisa ver: a ativação pode estar "active" e o acesso negado (licença cancelada/suspensa/expirada...).
const DENIED_AS = { LICENSE_CANCELLED: "cancelled", LICENSE_SUSPENDED: "suspended", LICENSE_BLOCKED: "blocked", LICENSE_EXPIRED: "expired", LICENSE_NOT_STARTED: "pending" };
export const accessStatus = (a) => (a.status !== "active" || !a.access || a.access.allowed ? a.status : DENIED_AS[a.access.code] ?? "blocked");
export function Badge({ status, label }) {
  const [text, tone] = STATUS[status] || [status, "muted"];
  return <span className={`badge ${tone}`}>{label || text}</span>;
}

/**
 * Modo de entrega EFETIVO de uma ativação (campos deliveryMode/deliveryModeFixed devolvidos pelo backend):
 * "proxy" = o servidor serve o conteúdo e o app nunca vê a URL/credencial real; "redirect" = o servidor autoriza e manda o
 * app para a origem (302), que recebe as credenciais reais. Lista própria do cliente é sempre proxy ("fixo").
 */
/** Tipo do aparelho, como o servidor guarda em devices.platform (rokutv vira roku; webtv vira web). */
export const PLATFORM_LABEL = { roku: "Roku", android: "Android TV", tizen: "Samsung", webos: "LG", web: "Web" };
/** Presença do aparelho (campos `online` e `lastSeenAt` devolvidos pelo backend). Offline mostra há quanto tempo foi visto. */
export function OnlineBadge({ online, lastSeenAt }) {
  return (
    <span title={lastSeenAt ? `Última atividade: ${fmtDateTime(lastSeenAt)}` : "Nunca deu sinal"}>
      <Badge status={online ? "online" : "offline"} />
      {!online && <div className="muted">{fmtAgo(lastSeenAt)}</div>}
    </span>
  );
}

export function PlatformBadge({ platform }) {
  if (!platform) return <span className="muted">—</span>;
  return <span className="badge info" title={`Plataforma: ${platform}`}>{PLATFORM_LABEL[platform] || platform}</span>;
}

export function DeliveryBadge({ mode, fixed }) {
  if (!mode) return <span className="muted">—</span>;
  const proxy = mode === "proxy";
  return (
    <span title={fixed ? "Lista própria do cliente: redirect automático (o superadmin pode forçar outro modo em Editar)." : proxy ? "O servidor serve o conteúdo; o app não vê a URL nem a credencial do provedor." : "O servidor autoriza e redireciona (302) para o provedor; o app recebe as credenciais reais."}>
      <Badge status={proxy ? "proxy" : "redirect"} />{fixed && <span className="muted"> fixo</span>}
    </span>
  );
}

/* ---------- Toasts e confirmações ---------- */
const Ctx = createContext(null);
export const useUi = () => useContext(Ctx);

export function UiProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);

  const toast = useCallback((message, tone = "ok") => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  // confirm({ title, message, danger, reason: "none" | "optional" | "required" }) -> { reason } | null
  const confirm = useCallback((opts) => new Promise((resolve) => setDialog({ opts, resolve })), []);
  const value = useMemo(() => ({ toast, confirm }), [toast, confirm]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.message}</div>)}</div>
      {dialog && <ConfirmDialog {...dialog} onClose={() => setDialog(null)} />}
    </Ctx.Provider>
  );
}

function ConfirmDialog({ opts, resolve, onClose }) {
  const [reason, setReason] = useState("");
  const need = opts.reason === "required";
  const done = (v) => { resolve(v); onClose(); };
  return (
    <Modal title={opts.title || "Confirmar"} onClose={() => done(null)}>
      <p>{opts.message}</p>
      {opts.reason && opts.reason !== "none" && (
        <Field label={need ? "Motivo (obrigatório)" : "Motivo (opcional)"}>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      <div className="actions">
        <button className="btn" onClick={() => done(null)}>Cancelar</button>
        <button className={`btn ${opts.danger ? "danger" : "primary"}`} disabled={need && reason.trim().length < 3}
          onClick={() => done({ reason: reason.trim() || undefined })}>
          {opts.confirmLabel || "Confirmar"}
        </button>
      </div>
    </Modal>
  );
}

/* ---------- Componentes básicos ---------- */
// Pilha de modais abertos: o Esc fecha só o do topo (antes fechava todos de uma vez — ex.: a confirmação e a janela de trás).
const modalStack = [];
export function Modal({ title, onClose, children, wide }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const me = Symbol("modal");
    modalStack.push(me);
    const onKey = (e) => e.key === "Escape" && modalStack[modalStack.length - 1] === me && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      modalStack.splice(modalStack.indexOf(me), 1);
    };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h3>{title}</h3><button className="icon" aria-label="Fechar" onClick={onClose}>×</button></header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export const Field = ({ label, hint, children }) => (
  <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
);

export function Pager({ meta, onPage }) {
  if (!meta) return null;
  return (
    <div className="pager">
      <span>{meta.total.toLocaleString("pt-BR")} registro(s)</span>
      <div>
        <button className="btn" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>Anterior</button>
        <span> Página {meta.page} de {meta.totalPages} </span>
        <button className="btn" disabled={meta.page >= meta.totalPages} onClick={() => onPage(meta.page + 1)}>Próxima</button>
      </div>
    </div>
  );
}

export const Table = ({ children }) => <div className="table-wrap"><table>{children}</table></div>;
export const Empty = ({ loading, error, count }) =>
  error ? <p className="error">{error}</p> : loading ? <p className="muted">Carregando…</p> : count === 0 ? <p className="muted">Nada encontrado.</p> : null;

/** Lista paginada: refaz a consulta quando os filtros mudam. */
export function useList(path, initial = {}) {
  const [params, setParams] = useState({ page: 1, ...initial });
  const [state, setState] = useState({ loading: true, data: [], meta: null, error: "" });
  const seq = useRef(0);
  const key = JSON.stringify(params);

  const reload = useCallback(async () => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const r = await api(path, { query: params });
      if (my === seq.current) setState({ loading: false, data: r.data, meta: r.meta, error: "" });
    } catch (e) {
      if (my === seq.current) setState({ loading: false, data: [], meta: null, error: e.message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key]);

  useEffect(() => { reload(); }, [reload]);
  return {
    ...state, params, reload,
    filter: (p) => setParams((prev) => ({ ...prev, ...p, page: 1 })),
    setPage: (page) => setParams((prev) => ({ ...prev, page })),
  };
}

/** Executa uma ação com toast de sucesso/erro. */
export function useAction() {
  const { toast } = useUi();
  return useCallback(async (fn, okMessage) => {
    try {
      const r = await fn();
      if (okMessage) toast(okMessage);
      return r ?? true;
    } catch (e) {
      toast(e.message, "bad"); // o backend já inclui o campo na mensagem (ex.: "code: Código inválido...")
      return null;
    }
  }, [toast]);
}

export const useDebounced = (value, ms = 350) => {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
};

// Código secreto exibido uma única vez (o banco guarda apenas o hash).
export function SecretCode({ code, onClose, title }) {
  return (
    <Modal title={title || "Código gerado"} onClose={onClose}>
      <p>Copie e guarde este código agora. <strong>Ele não será exibido novamente.</strong></p>
      <pre className="secret">{code}</pre>
      <div className="actions">
        <button className="btn" onClick={() => navigator.clipboard?.writeText(code)}>Copiar</button>
        <button className="btn primary" onClick={onClose}>Concluir</button>
      </div>
    </Modal>
  );
}

// Campo de senha com "mostrar": quem digita a senha de um cliente precisa conferir o que escreveu.
export function PasswordInput({ value, onChange, ...rest }) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-group">
      <input {...rest} type={show ? "text" : "password"} value={value} onChange={onChange} autoComplete="new-password" spellCheck={false} />
      <button type="button" className="btn sm" onClick={() => setShow((v) => !v)} aria-pressed={show}>{show ? "Ocultar" : "Mostrar"}</button>
    </div>
  );
}

/**
 * Carrega um registro para uma janela de detalhe. Se falhar, mostra o erro e permite tentar de novo
 * (antes a janela ficava em "Carregando…" para sempre e o erro virava exceção sem tratamento).
 */
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: "" });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const load = useCallback(async () => {
    try { setState({ data: await fnRef.current(), error: "" }); }
    catch (e) { setState((s) => ({ ...s, error: e.message })); }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setState({ data: null, error: "" }); load(); }, deps);
  return { ...state, reload: load, setData: (data) => setState({ data, error: "" }) };
}

export const LoadError = ({ error, onRetry }) => (
  <div><p className="error">{error}</p><button className="btn" onClick={onRetry}>Tentar novamente</button></div>
);

/** Logo do DeltaTV: um Δ com o botão de play recortado no meio. */
export function BrandMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ flex: "none" }}>
      <defs>
        <linearGradient id="dl-brand-g" x1="6" y1="4" x2="26" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8b89ff" /><stop offset="1" stopColor="#5a57f2" />
        </linearGradient>
      </defs>
      <path d="M16 3.5 29.5 27.5H2.5z" fill="url(#dl-brand-g)" />
      <path d="M13 15.2 20.4 19.6 13 24z" fill="#0a0c1a" />
    </svg>
  );
}

/* ---------- Menu de ações da linha (3 pontinhos) ----------
 * items: [{ label, onClick, danger, hidden, disabled, title }]. Itens `hidden` somem; sem itens visíveis o menu não aparece.
 * O popover é fixo na tela (portal), então não é cortado pela tabela; fecha com Esc, clique fora, rolagem ou ao escolher.
 */
export function RowMenu({ items, label = "Ações" }) {
  const list = items.filter((i) => i && !i.hidden);
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const menu = useRef(null);
  const close = useCallback(() => setPos(null), []);
  useEffect(() => {
    if (!pos) return undefined;
    const onDown = (e) => { if (!menu.current?.contains(e.target) && !btn.current?.contains(e.target)) close(); };
    const onKey = (e) => {
      if (e.key === "Escape") { close(); btn.current?.focus(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const els = [...(menu.current?.querySelectorAll("button:not(:disabled)") ?? [])];
        const i = els.indexOf(document.activeElement);
        els[(i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    menu.current?.querySelector("button:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos, close]);
  if (!list.length) return null;
  const toggle = () => {
    if (pos) return close();
    const r = btn.current.getBoundingClientRect();
    const h = list.length * 36 + 12;
    const up = r.bottom + h > window.innerHeight && r.top > h; // sem espaço embaixo: abre para cima
    setPos({ top: up ? r.top - h - 4 : r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  };
  return (
    <>
      <button ref={btn} type="button" className="btn sm kebab" aria-label={label} aria-haspopup="menu" aria-expanded={!!pos} title={label} onClick={toggle}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
      </button>
      {pos && createPortal(
        <div ref={menu} role="menu" className="rowmenu" style={{ top: pos.top, right: pos.right }}>
          {list.map((i, n) => (
            <button key={n} type="button" role="menuitem" className={i.danger ? "danger" : ""} disabled={i.disabled} title={i.title}
              onClick={() => { close(); i.onClick?.(); }}>{i.label}</button>
          ))}
        </div>, document.body)}
    </>
  );
}
