import { useEffect, useState } from "react";
import { api, getAuth } from "../api.js";
import { NewPlanInline } from "./Stock.jsx";
import { Badge, Empty, accessStatus, Field, LoadError, Modal, Pager, RowMenu, SecretCode, Table, fmtDate, fmtDateTime, fmtMoney, toCents, useAction, useDebounced, useList, useLoad, useUi } from "../ui.jsx";

const STATUSES = [["", "Todos os status"], ["active", "Ativas"], ["pending", "Pendentes"], ["expired", "Expiradas"], ["suspended", "Suspensas"], ["blocked", "Bloqueadas"], ["cancelled", "Canceladas"]];

export default function Licenses() {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const list = useList("/admin/licenses", { q: "", status: "" });
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [secret, setSecret] = useState(null);
  useEffect(() => { list.filter({ q: dq }); /* eslint-disable-next-line */ }, [dq]);

  return (
    <>
      <div className="page-head"><h2>Licenças individuais</h2><button className="btn primary" onClick={() => setCreating(true)}>Nova licença</button></div>
      <div className="toolbar">
        <input placeholder="Buscar por cliente, e-mail ou final do código" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={list.params.status} onChange={(e) => list.filter({ status: e.target.value })}>
          {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={list.params.expiringInDays || ""} onChange={(e) => list.filter({ expiringInDays: e.target.value })}>
          <option value="">Qualquer vencimento</option><option value="7">Vence em 7 dias</option><option value="30">Vence em 30 dias</option>
        </select>
      </div>
      <Table>
        <thead><tr><th>Cliente</th><th>Código</th><th>Plano</th><th>Status</th><th>Expira em</th><th>Dispositivos</th></tr></thead>
        <tbody>
          {list.data.map((l) => (
            <tr key={l.id} className="click" onClick={() => setOpenId(l.id)}>
              <td>{l.Customer?.name || "—"}<div className="muted">{l.Customer?.email}</div></td>
              <td>••••{l.codeLast4}</td><td>{l.Plan?.name}</td>
              <td><Badge status={l.effectiveStatus} /></td><td>{fmtDate(l.expiresAt)}</td><td>{l.deviceCount}/{l.maxDevices}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Empty loading={list.loading} error={list.error} count={list.data.length} />
      <Pager meta={list.meta} onPage={list.setPage} />
      {creating && <CreateLicense onClose={() => setCreating(false)} onCreated={(code) => { setCreating(false); setSecret(code); list.reload(); }} />}
      {openId && <LicenseDetail id={openId} onClose={() => setOpenId(null)} onChanged={list.reload} />}
      {secret && <SecretCode code={secret} title="Código da licença" onClose={() => setSecret(null)} />}
    </>
  );
}

function CreateLicense({ onClose, onCreated }) {
  const { toast } = useUi();
  const run = useAction();
  const [plans, setPlans] = useState([]);
  const [f, setF] = useState({ planId: "", name: "", email: "", phone: "", maxDevices: "", amount: "", method: "", startOnFirstActivation: false });
  useEffect(() => {
    // O plano padrão sai só dos ATIVOS (antes era o primeiro da lista, ativo ou não -> "Plano inválido ou inativo").
    api("/admin/licenses/plans")
      .then((r) => { const active = r.data.filter((p) => p.active); setPlans(active); setF((x) => ({ ...x, planId: (active.find((p) => p.durationMonths === 1) || active[0])?.id || "" })); })
      .catch((e) => toast(e.message, "bad"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  const submit = async () => {
    const amountCents = f.amount ? toCents(f.amount) : undefined;
    if (amountCents === null || amountCents === 0) return toast("Valor pago inválido. Use um número, ex.: 29,90.", "bad");
    const body = {
      planId: f.planId, startOnFirstActivation: f.startOnFirstActivation,
      customer: f.name ? { name: f.name, email: f.email || undefined, phone: f.phone || undefined } : undefined,
      maxDevices: f.maxDevices ? Number(f.maxDevices) : undefined,
      payment: amountCents ? { amountCents, method: f.method || undefined } : undefined,
    };
    const r = await run(() => api("/admin/licenses", { method: "POST", body }), "Licença criada.");
    if (r) onCreated(r.code);
  };
  return (
    <Modal title="Nova licença" onClose={onClose}>
      <Field label="Plano (duração)"><select value={f.planId} onChange={set("planId")}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <NewPlanInline onCreated={(p) => { setPlans((x) => (x.some((y) => y.id === p.id) ? x : [...x, p].sort((a, b) => a.durationMonths - b.durationMonths))); setF((x) => ({ ...x, planId: p.id })); }} />
      <div className="row"><Field label="Nome do cliente"><input value={f.name} onChange={set("name")} /></Field><Field label="E-mail"><input type="email" value={f.email} onChange={set("email")} /></Field></div>
      <div className="row"><Field label="Telefone"><input value={f.phone} onChange={set("phone")} /></Field><Field label="Limite de dispositivos" hint="Vazio = padrão do plano"><input type="number" min="1" max="50" value={f.maxDevices} onChange={set("maxDevices")} /></Field></div>
      <div className="row"><Field label="Valor pago (R$)" hint="Opcional: registra a venda"><input value={f.amount} onChange={set("amount")} /></Field><Field label="Forma de pagamento"><input value={f.method} onChange={set("method")} placeholder="pix, cartão…" /></Field></div>
      <label><input type="checkbox" style={{ width: "auto" }} checked={f.startOnFirstActivation} onChange={set("startOnFirstActivation")} /> Iniciar a validade na primeira ativação</label>
      <div className="actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!f.planId} onClick={submit}>Criar</button></div>
    </Modal>
  );
}

function LicenseDetail({ id, onClose, onChanged }) {
  const { confirm } = useUi();
  const run = useAction();
  const [tab, setTab] = useState("devices");
  const [renewing, setRenewing] = useState(false);
  const { data: l, error, reload: load, setData: setL } = useLoad(() => api(`/admin/licenses/${id}`), [id]);
  if (!l) return <Modal title="Licença" onClose={onClose}>{error ? <LoadError error={error} onRetry={load} /> : <p className="muted">Carregando…</p>}</Modal>;

  const act = async (action, o) => {
    const c = await confirm(o);
    if (!c) return;
    const r = await run(() => api(`/admin/licenses/${id}/${action}`, { method: "POST", body: { reason: c.reason } }), "Operação concluída.");
    if (r) { setL(r); onChanged(); }
  };
  const device = async (aid, action, o) => {
    const c = await confirm(o);
    if (!c) return;
    if (await run(() => api(`/admin/devices/activations/${aid}/${action}`, { method: "POST", body: { reason: c.reason } }), "Dispositivo atualizado.")) { load(); onChanged(); }
  };
  const s = l.effectiveStatus;
  const isSuper = getAuth()?.user?.role === "superadmin";

  return (
    <Modal title={`Licença ••••${l.codeLast4}`} onClose={onClose} wide>
      <dl className="kv">
        <dt>Cliente</dt><dd>{l.Customer?.name || "—"} {l.Customer?.email && <span className="muted">({l.Customer.email})</span>}</dd>
        <dt>Status</dt><dd><Badge status={s} /> {l.statusReason && <span className="muted">— {l.statusReason}</span>}</dd>
        <dt>Revendedor</dt><dd>{l.Owner?.name || "—"}</dd>
        <dt>Plano</dt><dd>{l.Plan?.name}</dd><dt>Validade</dt><dd>{fmtDateTime(l.startsAt)} → {fmtDateTime(l.expiresAt)}</dd>
        <dt>Dispositivos</dt><dd>{l.deviceCount}/{l.maxDevices}</dd><dt>Criada em</dt><dd>{fmtDateTime(l.createdAt)}</dd>
      </dl>
      <div className="actions left">
        {!["cancelled", "blocked"].includes(l.status) && <button className="btn primary" onClick={() => setRenewing(true)}>Renovar</button>}
        {l.status === "active" && <button className="btn" onClick={() => act("suspend", { title: "Suspender licença", message: "Todos os dispositivos perdem o acesso até a reativação.", reason: "optional" })}>Suspender</button>}
        {["active", "suspended"].includes(l.status) && <button className="btn danger" onClick={() => act("block", { title: "Bloquear licença", message: "Todos os dispositivos desta licença perdem o acesso imediatamente (no backend).", reason: "required", danger: true, confirmLabel: "Bloquear" })}>Bloquear</button>}
        {(["suspended", "blocked"].includes(l.status) || (isSuper && l.status === "cancelled")) && <button className="btn primary" onClick={() => act("reactivate", { title: "Reativar licença", message: l.status === "cancelled" ? "A licença cancelada volta a valer e os dispositivos recuperam o acesso (respeitando a validade). Fica registrado na auditoria." : "Os dispositivos elegíveis recuperam o acesso (respeitando a validade)." })}>Reativar</button>}
        {l.status !== "cancelled" && <button className="btn danger" onClick={() => act("cancel", { title: "Cancelar licença", message: "Os dispositivos perdem o acesso. Só o superadmin pode reativar depois.", reason: "required", danger: true, confirmLabel: "Cancelar licença" })}>Cancelar</button>}
      </div>
      <div className="tabs">{[["devices", "Dispositivos"], ["renewals", "Renovações"], ["payments", "Pagamentos"]].map(([k, n]) => <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{n}</button>)}</div>
      {tab === "devices" && (
        <Table><thead><tr><th>MAC</th><th>Status</th><th>Origem</th><th>Ativado em</th><th /></tr></thead><tbody>
          {l.Activations.length === 0 && <tr><td colSpan={5} className="muted">Nenhum dispositivo ligado a esta licença.</td></tr>}
          {l.Activations.map((a) => (
            <tr key={a.id}><td>{a.mac}</td><td><Badge status={accessStatus(a)} />{a.statusReason && <span className="muted"> {a.statusReason}</span>}{a.status === "active" && a.access && !a.access.allowed && <div className="muted">{a.access.message}</div>}</td><td>{a.viaPartner ? `Código de revenda${a.Partner?.name ? ` · ${a.Partner.name}` : ""}` : "Licença individual"}</td><td>{fmtDateTime(a.activatedAt)}</td>
              <td className="actions">
                <RowMenu items={[
                  { label: "Bloquear", hidden: !(a.status === "active"), onClick: () => device(a.id, "block", { title: "Bloquear dispositivo", message: `Somente ${a.mac} perde o acesso.`, reason: "required", danger: true }) },
                  { label: "Desbloquear", hidden: !(a.status === "blocked"), onClick: () => device(a.id, "unblock", { title: "Desbloquear", message: a.mac }) },
                  { label: "Restaurar", hidden: !(a.status === "revoked" && isSuper), onClick: () => device(a.id, "restore", { title: "Restaurar ativação", message: `Desfaz a remoção de ${a.mac}.` }) },
                  { label: "Remover", danger: true, hidden: !(a.status !== "revoked"), onClick: () => device(a.id, "revoke", { title: "Remover ativação", message: `Remove somente este vínculo; as outras listas do MAC ${a.mac} continuam.`, reason: "optional", danger: true }) },
                ]} />
              </td></tr>
          ))}
        </tbody></Table>
      )}
      {tab === "renewals" && <Table><thead><tr><th>Em</th><th>Plano</th><th>Antes</th><th>Depois</th></tr></thead><tbody>{l.Renewals.map((r) => <tr key={r.id}><td>{fmtDateTime(r.createdAt)}</td><td>{r.Plan?.name}</td><td>{fmtDate(r.previousExpiresAt)}</td><td>{fmtDate(r.newExpiresAt)}</td></tr>)}</tbody></Table>}
      {tab === "payments" && <Table><thead><tr><th>Data</th><th>Valor</th><th>Forma</th><th>Origem</th></tr></thead><tbody>{l.Payments.map((p) => <tr key={p.id}><td>{fmtDateTime(p.paidAt)}</td><td>{fmtMoney(p.amountCents)}</td><td>{p.method || "—"}</td><td>{p.origin}</td></tr>)}</tbody></Table>}
      {renewing && <Renew license={l} onClose={() => setRenewing(false)} onDone={(r) => { setRenewing(false); setL(r); onChanged(); }} />}
    </Modal>
  );
}

function Renew({ license, onClose, onDone }) {
  const { toast } = useUi();
  const run = useAction();
  const [plans, setPlans] = useState([]);
  const [planId, setPlanId] = useState("");
  const [amount, setAmount] = useState("");
  useEffect(() => {
    // Se o plano atual foi desativado, ele não está na lista: a seleção cai no primeiro ativo (antes o campo mostrava um plano e enviava outro).
    api("/admin/licenses/plans")
      .then((r) => { const active = r.data.filter((p) => p.active); setPlans(active); setPlanId(active.some((p) => p.id === license.planId) ? license.planId : (active.find((p) => p.durationMonths === 1) || active[0])?.id || ""); })
      .catch((e) => toast(e.message, "bad"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const submit = async () => {
    const amountCents = amount ? toCents(amount) : undefined;
    if (amountCents === null || amountCents === 0) return toast("Valor pago inválido. Use um número, ex.: 29,90.", "bad");
    const r = await run(() => api(`/admin/licenses/${license.id}/renew`, { method: "POST", body: { planId, payment: amountCents ? { amountCents, method: "manual" } : undefined } }), "Licença renovada.");
    if (r) onDone(r);
  };
  return (
    <Modal title="Renovar licença" onClose={onClose}>
      <p className="muted">Renovar antes do vencimento soma ao saldo; depois do vencimento, conta a partir de hoje.</p>
      <Field label="Plano"><select value={planId} onChange={(e) => setPlanId(e.target.value)}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <NewPlanInline onCreated={(p) => { setPlans((x) => (x.some((y) => y.id === p.id) ? x : [...x, p].sort((a, b) => a.durationMonths - b.durationMonths))); setPlanId(p.id); }} />
      <Field label="Valor pago (R$)" hint="Opcional"><input value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <div className="actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!planId} onClick={submit}>Renovar</button></div>
    </Modal>
  );
}
