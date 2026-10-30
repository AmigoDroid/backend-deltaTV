import { useEffect, useState } from "react";
import { api, getAuth, login, logout } from "./api.js";
import { UiProvider, Field, useAction, BrandMark } from "./ui.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Licenses from "./pages/Licenses.jsx";
import Partners, { Resellers } from "./pages/Partners.jsx";
import Devices from "./pages/Devices.jsx";
import Unlinked from "./pages/Unlinked.jsx";
import Sources from "./pages/Sources.jsx";
import Billing from "./pages/Billing.jsx";
import Pix from "./pages/Pix.jsx";
import Credits from "./pages/Credits.jsx";
import Audit from "./pages/Audit.jsx";
import DeviceAccess from "./pages/DeviceAccess.jsx";
import Clients from "./pages/Clients.jsx";
import Users from "./pages/Users.jsx";
import Mail from "./pages/Mail.jsx";
import WebAccessPage from "./pages/WebAccess.jsx";

const WebAccess = () => <WebAccessPage admin />;

const PAGES = {
  dashboard: ["Visão geral", Dashboard],
  webaccess: ["Player Web", WebAccess],
  licenses: ["Licenças", Licenses], devices: ["Dispositivos", Devices], unlinked: ["Sem vínculo", Unlinked],
  partners: ["Parceiros", Partners], sources: ["Fontes de conteúdo", Sources],
  resellers: ["Revendas", Resellers], clients: ["Clientes", Clients], credits: ["Créditos", Credits],
  billing: ["Financeiro", Billing], pix: ["Pix", Pix],
  users: ["Usuários", Users], mail: ["E-mails", Mail], audit: ["Auditoria", Audit],
};

// Menu por área: quem é de conteúdo (Parceiros) fica separado de quem vende licença (Revendas e seus clientes).
const GROUPS = [
  { label: null, items: ["dashboard"] },
  { label: "Licenciamento", items: ["licenses", "devices", "unlinked", "webaccess"] },
  { label: "Parceiros", items: ["partners", "sources"] },
  { label: "Revendas", items: ["resellers", "clients", "credits"] },
  { label: "Financeiro", items: ["billing", "pix"] },
  { label: "Sistema", items: ["users", "mail", "audit"] },
];

// Ícones do menu (traço simples, herdam a cor do texto).
const ICONS = {
  dashboard: <><rect x="3" y="3" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="2" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" /></>,
  licenses: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3M14 9l2 2" /></>,
  partners: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5" /><path d="M16 4.8a3.5 3.5 0 010 6.4M18.5 14.8c1.7.7 2.8 2.3 3 5.2" /></>,
  resellers: <><path d="M4 9l1.5-5h13L20 9" /><path d="M4 9a2.5 2.5 0 005 0 2.5 2.5 0 005 0 2.5 2.5 0 005 0" /><path d="M5 12v8h14v-8M10 20v-5h4v5" /></>,
  clients: <><circle cx="12" cy="8" r="4" /><path d="M4 21c.8-4 4-6 8-6s7.2 2 8 6" /></>,
  devices: <><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  unlinked: <><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" /><path d="M4 4l16 16" /></>,
  sources: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  billing: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10.5h18M7 15h3" /></>,
  pix: <><path d="M12 2.8l9.2 9.2-9.2 9.2L2.8 12z" /><path d="M12 8l4 4-4 4-4-4z" /></>,
  credits: <><circle cx="12" cy="12" r="9" /><path d="M14.8 9.3c-.5-.9-1.5-1.3-2.8-1.3-1.7 0-2.8.8-2.8 2 0 3 5.6 1.2 5.6 4.2 0 1.2-1.1 2-2.8 2-1.3 0-2.4-.5-2.9-1.4M12 6.5V8m0 8v1.5" /></>,
  users: <path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" />,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  webaccess: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></>,
  audit: <><path d="M8 3h8v3H8z" /><path d="M6 5H5a1 1 0 00-1 1v14a1 1 0 001 1h14a1 1 0 001-1V6a1 1 0 00-1-1h-1M8 12h8M8 16h5" /></>,
};
const NavIcon = ({ k }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[k]}</svg>
);

function Login({ onDeviceAccess }) {
  const run = useAction();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    await run(() => login(email, password));
    setBusy(false);
  };
  return (
    <div className="auth">
      <div className="login card">
        <div className="auth-brand"><BrandMark size={44} /><div><strong>DeltaTV</strong><span>Painel de licenciamento</span></div></div>
        <h2>Entrar</h2>
        <p className="muted auth-sub">Use o e-mail e a senha da sua conta.</p>
        <form onSubmit={submit}>
          <Field label="E-mail"><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Senha"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          <button className="btn primary block" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
        </form>
        <div className="auth-alt"><button className="btn sm" onClick={onDeviceAccess}>Acessar com a chave da TV</button></div>
      </div>
    </div>
  );
}

function Shell({ user }) {
  // Itens do menu são conveniência: cada rota é protegida por permissão no backend.
  const hidden = (k) => (user.role === "support" && k === "audit") || ((k === "users" || k === "mail") && user.role !== "superadmin");
  const menu = Object.entries(PAGES).filter(([k]) => !hidden(k));
  const allowed = (h) => menu.some(([k]) => k === h);
  const fromHash = () => (allowed(location.hash.slice(1)) ? location.hash.slice(1) : "dashboard");
  const [page, setPage] = useState(fromHash);
  useEffect(() => { if (location.hash.slice(1) !== page) location.hash = page; }, [page]);
  // Botão voltar/avançar do navegador e links #pagina: sincroniza a tela com o endereço (e barra páginas sem permissão).
  useEffect(() => {
    const onHash = () => setPage(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.role]);
  const Current = PAGES[page][1];

  // Selos do menu: dispositivos aguardando vínculo e cadastros de revenda aguardando aprovação. Falhar aqui nunca atrapalha o painel.
  const [badges, setBadges] = useState({});
  const refreshCounts = () => {
    api("/admin/devices/unlinked", { query: { pageSize: 1 } }).then((r) => setBadges((b) => ({ ...b, unlinked: r.meta.total }))).catch(() => {});
    api("/admin/partners", { query: { status: "pending", pageSize: 1 } }).then((r) => setBadges((b) => ({ ...b, resellers: r.meta.total }))).catch(() => {});
  };
  useEffect(() => {
    refreshCounts();
    const t = setInterval(() => { if (!document.hidden) refreshCounts(); }, 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand"><BrandMark size={32} /><div><strong>DeltaTV</strong><span>Licenciamento</span></div></div>
        <nav className="nav-scroll" aria-label="Menu principal">
          {GROUPS.map((g) => {
            const items = g.items.filter(allowed);
            if (!items.length) return null;
            return (
              <div className="nav-group" key={g.label || "top"}>
                {g.label && <div className="nav-heading">{g.label}</div>}
                {items.map((k) => (
                  <button key={k} className={`nav ${page === k ? "active" : ""}`} onClick={() => setPage(k)}>
                    <span className="nav__label"><NavIcon k={k} />{PAGES[k][0]}</span>
                    {badges[k] > 0 && <span className="count" aria-label={`${badges[k]} aguardando`}>{badges[k] > 99 ? "99+" : badges[k]}</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="user">
          <span className="avatar" aria-hidden="true">{(user.name || user.email || "?").trim().charAt(0).toUpperCase()}</span>
          <div className="who"><strong>{user.name}</strong><span>{user.email}</span></div>
          <button className="btn sm" onClick={logout}>Sair</button>
        </div>
      </aside>
      <main className="content"><Current onChanged={refreshCounts} /></main>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState(getAuth());
  useEffect(() => {
    const h = () => setAuth(getAuth());
    window.addEventListener("auth-changed", h);
    return () => window.removeEventListener("auth-changed", h);
  }, []);
  // Login de dispositivo (MAC + chave da TV): sessão própria, limitada a um dispositivo; independente do login do painel.
  const [deviceMode, setDeviceMode] = useState(() => location.hash === "#dispositivo");
  const toDevice = (on) => { setDeviceMode(on); location.hash = on ? "dispositivo" : ""; };
  return (
    <UiProvider>
      {auth?.user && auth.user.role !== "partner" ? <Shell user={auth.user} /> : deviceMode ? <DeviceAccess onBack={() => toDevice(false)} /> : <Login onDeviceAccess={() => toDevice(true)} />}
    </UiProvider>
  );
}
