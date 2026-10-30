import { useEffect, useState } from "react";
import { api } from "../api.js";
import CodeModal from "./CodeModal.jsx";
import MacDevice from "./MacDevice.jsx";
import { StockPortal } from "./Stock.jsx";
import { Badge, Empty, Pager, Table, fmtDate, fmtDateTime, fmtMoney, useAction, useDebounced, useList, useUi } from "../ui.jsx";

// Portal do parceiro: o backend restringe tudo ao parceiro do token (nunca confie neste front).
export default function PartnerPortal() {
  const { confirm } = useUi();
  const run = useAction();
  const [me, setMe] = useState(null);
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const devices = useList("/partner/devices", { q: "" });
  const invoices = useList("/partner/invoices", {});
  const [codes, setCodes] = useState([]);
  const [newCode, setNewCode] = useState(false);
  const [providers, setProviders] = useState([]);
  const loadCodes = () => api("/partner/codes").then((r) => setCodes(r.data));
  useEffect(() => { api("/partner/me").then(setMe); api("/partner/providers").then((r) => setProviders(r.data)); loadCodes(); }, []);
  useEffect(() => { devices.filter({ q: dq }); /* eslint-disable-next-line */ }, [dq]);

  const change = async (a, action, o) => {
    const c = await confirm(o);
    if (c && (await run(() => api(`/partner/devices/${a.id}/${action}`, { method: "POST", body: { reason: c.reason } }), "Atualizado."))) devices.reload();
  };
  const revoke = async (c) => { if (await confirm({ title: "Revogar código", message: "Impede novas ativações com este código.", danger: true }) && await run(() => api(`/partner/codes/${c.id}/revoke`, { method: "POST" }), "Código revogado.")) loadCodes(); };

  return (
    <>
      <div className="page-head"><h2>{me?.name || "Minha parceria"}</h2>{me && <Badge status={me.effectiveStatus} />}</div>
      {me && <div className="grid cards"><div className="card stat"><small>Dispositivos</small><strong>{me.deviceCount}{me.deviceLimit != null ? `/${me.deviceLimit}` : ""}</strong></div><div className="card stat"><small>Vigência até</small><strong>{fmtDate(me.endsAt)}</strong></div><div className="card stat"><small>Vencimento</small><strong>dia {me.dueDay}</strong><span>tolerância {me.graceDays} dia(s)</span></div></div>}
      {(me?.kind === "reseller" || me?.kind === "both") && <><StockPortal /><MacDevice /></>}
      <h3>Servidores do provedor</h3>
      <Table><thead><tr><th>Nome</th><th>URL base</th><th>Status</th></tr></thead><tbody>{providers.map((p) => <tr key={p.id}><td>{p.name}</td><td>{p.baseUrl}</td><td><Badge status={p.status} /></td></tr>)}</tbody></Table>
      <p className="muted">Para alterar os servidores, fale com a plataforma.</p>
      <h3>Códigos de ativação</h3>
      <div className="actions left"><button className="btn primary" onClick={() => setNewCode(true)}>Novo código</button></div>
      <Table><thead><tr><th>Código</th><th>Servidor</th><th>Status</th><th>Ativações máx.</th><th /></tr></thead><tbody>{codes.map((c) => <tr key={c.id}><td><strong>{c.code}</strong></td><td>{c.provider?.name || <span className="muted">Qualquer servidor</span>}</td><td>{c.status === "active" ? "Ativo" : "Revogado"}</td><td>{c.maxActivations ?? "∞"}</td><td className="actions">{c.status === "active" && <button className="btn sm danger" onClick={() => revoke(c)}>Revogar</button>}</td></tr>)}</tbody></Table>
      <h3 style={{ marginTop: 20 }}>Meus dispositivos</h3>
      <div className="toolbar"><input placeholder="Pesquisar por MAC" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <Table><thead><tr><th>MAC</th><th>Status</th><th>Ativado em</th><th /></tr></thead><tbody>{devices.data.map((a) => (
        <tr key={a.id}><td className="mono">{a.mac || "—"}</td><td><Badge status={a.status} /></td><td>{fmtDateTime(a.activatedAt)}</td><td className="actions">
          {a.status === "active" && <button className="btn sm" onClick={() => change(a, "block", { title: "Bloquear dispositivo", message: a.mac, reason: "required", danger: true })}>Bloquear</button>}
          {a.status === "blocked" && <button className="btn sm" onClick={() => change(a, "unblock", { title: "Desbloquear", message: a.mac })}>Desbloquear</button>}
          {a.status !== "revoked" && <button className="btn sm danger" onClick={() => change(a, "revoke", { title: "Remover ativação", message: a.mac, danger: true })}>Remover</button>}</td></tr>))}</tbody></Table>
      <Empty loading={devices.loading} error={devices.error} count={devices.data.length} /><Pager meta={devices.meta} onPage={devices.setPage} />
      <h3 style={{ marginTop: 20 }}>Mensalidades</h3>
      <Table><thead><tr><th>Competência</th><th>Valor</th><th>Pago</th><th>Vencimento</th><th>Status</th></tr></thead><tbody>{invoices.data.map((i) => <tr key={i.id}><td>{i.competence}</td><td>{fmtMoney(i.amountCents)}</td><td>{fmtMoney(i.paidCents)}</td><td>{fmtDate(i.dueDate)}</td><td><Badge status={i.status} /></td></tr>)}</tbody></Table>
      {newCode && <CodeModal checkPath="/partner/codes/check" createPath="/partner/codes" providers={providers} onClose={() => setNewCode(false)} onCreated={() => { setNewCode(false); loadCodes(); }} />}
    </>
  );
}
