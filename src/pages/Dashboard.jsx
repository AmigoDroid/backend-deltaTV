import { useEffect, useState } from "react";
import { api, getAuth } from "../api.js";
import { isPending } from "./Partners.jsx";
import { Badge, Table, fmtDate, fmtDateTime, fmtMoney } from "../ui.jsx";

/* Ícones de traço simples, no mesmo estilo do menu. */
const I = {
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3M14 9l2 2" /></>,
  tv: <><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  pulse: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
  unlink: <><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" /><path d="M4 4l16 16" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5" /><path d="M16 4.8a3.5 3.5 0 010 6.4M18.5 14.8c1.7.7 2.8 2.3 3 5.2" /></>,
  store: <><path d="M4 9l1.5-5h13L20 9" /><path d="M4 9a2.5 2.5 0 005 0 2.5 2.5 0 005 0 2.5 2.5 0 005 0" /><path d="M5 12v8h14v-8M10 20v-5h4v5" /></>,
  trend: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />,
  cash: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10.5h18M7 15h3" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
};
const Ico = ({ k }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{I[k]}</svg>
);

const Stat = ({ label, value, hint, href, tone, icon, children }) => {
  const body = (
    <>
      <div className="stat-top"><small>{label}</small>{icon && <span className={`stat-ico ${tone || ""}`}><Ico k={icon} /></span>}</div>
      <strong>{value}</strong>
      {hint && <span>{hint}</span>}
      {children}
    </>
  );
  const cls = `card stat ${href ? "link" : ""} ${tone === "warn" ? "attention" : ""}`;
  return href ? <a className={cls} href={href}>{body}</a> : <div className={cls}>{body}</div>;
};

const Section = ({ title, hint, children }) => (
  <section className="dash-section">
    <div className="section-title"><h3>{title}</h3>{hint && <span className="muted">{hint}</span>}</div>
    {children}
  </section>
);

/* Barra de distribuição das licenças: dá para ver de relance quanto está saudável. */
function LicenseBar({ l }) {
  const segs = [["Ativas", l.active, "var(--ok)"], ["Expiradas", l.expired, "var(--warn)"], ["Suspensas", l.suspended, "var(--info)"], ["Bloqueadas", l.blocked, "var(--bad)"]];
  const total = segs.reduce((s, x) => s + x[1], 0);
  if (!total) return null;
  return (
    <>
      <div className="bar" role="img" aria-label={segs.map(([n, v]) => `${n}: ${v}`).join(", ")}>
        {segs.filter((x) => x[1] > 0).map(([n, v, c]) => <i key={n} style={{ flex: v, background: c }} title={`${n}: ${v}`} />)}
      </div>
      <div className="legend">{segs.map(([n, v, c]) => <span key={n}><b style={{ background: c }} />{n} {v}</span>)}</div>
    </>
  );
}

const Group = ({ title, tone, items, render }) => (
  <div className="alert-group">
    <header><h4>{title}</h4><span className={`badge ${items.length ? tone : "ok"}`}>{items.length ? items.length : "Em dia"}</span></header>
    {items.length > 0 && <ul className="plain">{items.map(render)}</ul>}
  </div>
);

export default function Dashboard() {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const [presence, setPresence] = useState(null);
  const [parts, setParts] = useState(null);
  const user = getAuth()?.user;

  useEffect(() => { api("/admin/dashboard").then(setD).catch((e) => setError(e.message)); }, []);
  // Parceiros x revendas: o resumo do servidor soma os dois, então separamos pela lista (falhar aqui não atrapalha o painel).
  useEffect(() => { api("/admin/partners", { query: { pageSize: 100 } }).then(setParts).catch(() => {}); }, []);
  // Só a contagem de online é atualizada em tempo quase real (consulta leve); o resto do painel não é recarregado.
  useEffect(() => {
    const load = () => { if (!document.hidden) api("/admin/devices/presence").then(setPresence).catch(() => {}); };
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!d) return <p className="muted">Carregando…</p>;

  const rows = parts?.data ?? [];
  const split = !!parts && parts.meta.total <= rows.length; // lista completa -> dá para separar com segurança
  const active = (p) => p.effectiveStatus === "active";
  const partnersActive = rows.filter((p) => p.kind !== "reseller" && active(p)).length;
  const partnersOff = rows.filter((p) => p.kind !== "reseller" && !active(p)).length;
  const resellersActive = rows.filter((p) => p.kind !== "content" && active(p)).length;
  const resellersOff = rows.filter((p) => p.kind !== "content" && !active(p) && !isPending(p)).length;
  const pendingSignups = rows.filter(isPending).length;

  const overdue = d.billing.pending.overdueCount;
  const attention = [
    d.devices.unlinked > 0 && { href: "#unlinked", tone: "warn", text: `${d.devices.unlinked} dispositivo(s) sem vínculo` },
    pendingSignups > 0 && { href: "#resellers", tone: "warn", text: `${pendingSignups} cadastro(s) de revenda aguardando aprovação` },
    overdue > 0 && { href: "#billing", tone: "bad", text: `${overdue} cobrança(s) vencida(s)` },
    d.alerts.expiringLicenses.length > 0 && { href: "#licenses", tone: "info", text: `${d.alerts.expiringLicenses.length} licença(s) vencem em 7 dias` },
    d.alerts.endingPartners.length > 0 && { href: "#partners", tone: "info", text: `${d.alerts.endingPartners.length} parceria(s) terminam em 15 dias` },
  ].filter(Boolean);

  const first = (user?.name || "").trim().split(/\s+/)[0];
  const today = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Sao_Paulo" });
  const licTotal = d.licenses.active + d.licenses.expired + d.licenses.suspended + d.licenses.blocked;

  return (
    <>
      <div className="page-head">
        <div><h2>{first ? `Olá, ${first}` : "Visão geral"}</h2><p className="muted page-sub dash-date">{today}</p></div>
      </div>

      <div className={`attn ${attention.length ? "" : "ok"}`}>
        {attention.length
          ? <>
              <span className="attn-title">Precisa de atenção</span>
              {attention.map((a) => <a key={a.href} href={a.href} className={`attn-pill ${a.tone}`}>{a.text} →</a>)}
            </>
          : <><span className="attn-title">Tudo em dia</span><span className="muted">Nada pendente: sem dispositivos aguardando, cobranças vencidas ou vencimentos próximos.</span></>}
      </div>

      <Section title="Licenciamento" hint="Licenças individuais e aparelhos">
        <div className="grid cards">
          <Stat icon="key" label="Licenças ativas" value={d.licenses.active} hint={`${licTotal} no total`}><LicenseBar l={d.licenses} /></Stat>
          <Stat icon="tv" label="Dispositivos ativados" value={d.devices.active} hint={`${d.devices.blocked} bloqueados`} href="#devices" />
          <Stat icon="pulse" tone="ok" label="Online agora" value={presence ? presence.online : "—"} hint={presence ? `Atividade nos últimos ${presence.windowSeconds} s` : "Carregando…"} href="#devices" />
          <Stat icon="unlink" tone={d.devices.unlinked > 0 ? "warn" : ""} label="Sem vínculo" value={d.devices.unlinked ?? 0} hint={d.devices.unlinked ? "Aguardando configuração →" : "Nenhum aguardando"} href="#unlinked" />
        </div>
      </Section>

      <Section title="Parceiros e revendas" hint="Cada um com a sua tela no menu">
        <div className="grid cards">
          {split ? (
            <>
              <Stat icon="users" label="Parceiros ativos" value={partnersActive} hint={partnersOff ? `${partnersOff} inativo(s)` : "Provedores de conteúdo"} href="#partners" />
              <Stat icon="store" tone={pendingSignups ? "warn" : ""} label="Revendas ativas" value={resellersActive} hint={pendingSignups ? `${pendingSignups} aguardando aprovação →` : resellersOff ? `${resellersOff} inativa(s)` : "Compram licença e atendem clientes"} href="#resellers" />
            </>
          ) : (
            <Stat icon="users" label="Parceiros e revendas ativos" value={d.partners.active} hint={`${d.partners.suspended} suspensos/bloqueados`} href="#partners" />
          )}
        </div>
      </Section>

      <Section title="Financeiro" hint="Mensalidades dos parceiros e revendas">
        <div className="grid cards">
          <Stat icon="trend" label="Receita recorrente prevista" value={fmtMoney(d.billing.mrrCents)} hint="Soma das mensalidades ativas" />
          <Stat icon="cash" tone="ok" label="Recebido no mês" value={fmtMoney(d.billing.receivedThisMonthCents)} />
          <Stat icon="clock" tone={overdue ? "bad" : ""} label="Cobranças pendentes" value={d.billing.pending.count} hint={`${fmtMoney(d.billing.pending.amountCents)} · ${overdue} vencida(s)`} href="#billing" />
        </div>
      </Section>

      <div className="grid two dash-lists">
        <div className="card">
          <h3>Vencimentos e cobranças</h3>
          <Group title="Licenças que vencem em 7 dias" tone="warn" items={d.alerts.expiringLicenses}
            render={(l) => <li key={l.id}><span className="mono">••••{l.codeLast4}</span><span>{fmtDate(l.expiresAt)}</span></li>} />
          <Group title="Parcerias que terminam em 15 dias" tone="warn" items={d.alerts.endingPartners}
            render={(p) => <li key={p.id}><span>{p.name}</span><span>{fmtDate(p.endsAt)}</span></li>} />
          <Group title="Cobranças vencidas" tone="bad" items={d.alerts.overdueInvoices}
            render={(i) => <li key={i.id}><span>{i.Partner?.name} · {i.competence}</span><span>{fmtMoney(i.amountCents - i.paidCents)} · {fmtDate(i.dueDate)}</span></li>} />
        </div>
        <div className="card">
          <h3>Bloqueios e reativações</h3>
          <ul className="plain">
            {d.events.map((e) => <li key={e.id}><span className="mono">{e.action}</span><span className="muted">{fmtDateTime(e.createdAt)}</span></li>)}
            {!d.events.length && <li className="muted">Nenhum evento recente</li>}
          </ul>
        </div>
      </div>

      <Section title="Ativações recentes" hint={<a href="#devices">Ver todos os dispositivos →</a>}>
        <Table>
          <thead><tr><th>MAC</th><th>Origem</th><th>Status</th><th>Quando</th></tr></thead>
          <tbody>
            {d.recentActivations.map((a) => <tr key={a.id}><td className="mono">{a.mac || "—"}</td><td>{a.licenseId ? "Licença individual" : "Parceria / revenda"}</td><td><Badge status={a.status} /></td><td>{fmtDateTime(a.activatedAt)}</td></tr>)}
            {!d.recentActivations.length && <tr><td colSpan={4} className="muted">Nenhuma ativação ainda.</td></tr>}
          </tbody>
        </Table>
      </Section>
    </>
  );
}
