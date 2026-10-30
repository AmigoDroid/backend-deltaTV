import { useEffect, useState } from "react";
import { api, getAuth } from "../api.js";
import { NewWebAccess } from "./WebAccess.jsx";
import { Badge, Empty, Field, Modal, Pager, RowMenu, Table, fmtDate, fmtMoney, formatMac, toCents, useAction, useDebounced, useList, useLoad, useUi } from "../ui.jsx";

/**
 * Clientes das revendas (ficha por MAC: nome, telefone, endereço, valor e vencimento).
 * No painel admin não há isolamento: enxerga e edita as fichas de TODAS as revendas e pode mover uma ficha de revenda.
 * `partnerId` fixo = aba dentro do detalhe de uma revenda; sem ele = tela geral com filtro por revenda.
 */
const FILTER_LABEL = { all: "Todos", overdue: "Vencidos", due_soon: "Vencem em breve", no_due: "Sem vencimento" };

function usePartners(enabled = true) {
  const [list, setList] = useState([]);
  useEffect(() => {
    if (!enabled) return;
    api("/admin/partners", { query: { pageSize: 100 } }).then((r) => setList(r.data)).catch(() => {});
  }, [enabled]);
  return list;
}

const Stat = ({ label, value, hint }) => <div className="card stat"><small>{label}</small><strong>{value}</strong>{hint && <span>{hint}</span>}</div>;

function DueBadge({ c }) {
  if (!c.dueDate) return <span className="muted">—</span>;
  const d = c.daysLeft;
  const tone = d < 0 ? "bad" : d <= 7 ? "warn" : "ok";
  const text = d < 0 ? `venceu há ${-d} dia(s)` : d === 0 ? "vence hoje" : `em ${d} dia(s)`;
  return <>{fmtDate(`${c.dueDate}T12:00:00Z`)} <span className={`badge ${tone}`}>{text}</span></>;
}

export function ClientsPanel({ partnerId: fixedPartnerId }) {
  const canWrite = getAuth()?.user?.role !== "support";
  const [webFor, setWebFor] = useState(null); // ficha/MAC para a qual se gera um acesso do Player Web
  const { confirm } = useUi();
  const run = useAction();
  const partners = usePartners(!fixedPartnerId);
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const list = useList("/admin/clients", { q: "", filter: "", partnerId: fixedPartnerId || "" });
  const [form, setForm] = useState(null); // null | { client? , prefill? }
  const partnerId = fixedPartnerId || list.params.partnerId;
  const { data: sum, reload: reloadSum } = useLoad(() => api("/admin/clients/summary", { query: { partnerId } }), [partnerId]);
  useEffect(() => { list.filter({ q: dq }); /* eslint-disable-next-line */ }, [dq]);
  const refresh = () => { list.reload(); reloadSum(); };

  const remove = async (c) => {
    if (!(await confirm({ title: "Excluir cliente", message: `${c.name} (${c.mac}). Só a ficha é apagada; dispositivo, ativação e licença continuam como estão.`, danger: true, confirmLabel: "Excluir" }))) return;
    if (await run(() => api(`/admin/clients/${c.clientId}`, { method: "DELETE" }), "Cliente excluído.")) refresh();
  };

  return (
    <>
      {sum && <div className="grid cards">
        <Stat label="Clientes cadastrados" value={sum.clients} />
        <Stat label="Vencidos" value={sum.overdue} />
        <Stat label="Vencem em breve" value={sum.dueSoon} hint={`próximos ${sum.dueSoonDays} dias`} />
        <Stat label="Receita mensal dos clientes" value={fmtMoney(sum.monthlyCents)} />
      </div>}
      <div className="toolbar">
        <input placeholder="Buscar por nome, telefone, endereço, MAC ou revenda" value={q} onChange={(e) => setQ(e.target.value)} />
        {!fixedPartnerId && (
          <select value={list.params.partnerId} onChange={(e) => list.filter({ partnerId: e.target.value, filter: list.params.filter === "unregistered" ? "" : list.params.filter })}>
            <option value="">Todas as revendas</option>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <select value={list.params.filter} onChange={(e) => list.filter({ filter: e.target.value })}>
          {Object.entries(FILTER_LABEL).map(([k, v]) => <option key={k} value={k === "all" ? "" : k}>{v}</option>)}
          {partnerId && <option value="unregistered">TVs sem ficha</option>}
        </select>
        {canWrite && <button className="btn primary" onClick={() => setForm({})}>Novo cliente</button>}
      </div>
      <Table>
        <thead><tr>{!fixedPartnerId && <th>Revenda</th>}<th>Cliente</th><th>MAC</th><th>Contato</th><th>Valor</th><th>Vencimento</th><th>Dispositivo</th><th /></tr></thead>
        <tbody>{list.data.map((c) => (
          <tr key={`${c.partnerId}-${c.mac}`}>
            {!fixedPartnerId && <td>{c.partnerName}</td>}
            <td>{c.name || <span className="muted">Sem ficha</span>}{c.notes && <div className="muted">{c.notes}</div>}</td>
            <td className="mono">{c.mac}</td>
            <td>{c.phone || "—"}{c.address && <div className="muted">{c.address}</div>}</td>
            <td>{c.priceCents != null ? fmtMoney(c.priceCents) : "—"}</td>
            <td><DueBadge c={c} /></td>
            <td>{c.device ? <><Badge status={c.device.status} />{c.device.licenseExpiresAt && <div className="muted">licença até {fmtDate(c.device.licenseExpiresAt)}</div>}</> : <span className="muted">Só cadastro</span>}</td>
            <td className="actions">{canWrite && (
              <RowMenu items={[
                { label: "Gerar acesso Player Web", hidden: !(c.mac && c.device && c.device.status !== "revoked"), onClick: () => setWebFor(c) },
                { label: "Editar", hidden: !c.clientId, onClick: () => setForm({ client: c }) },
                { label: "Cadastrar", hidden: !!c.clientId, onClick: () => setForm({ prefill: { partnerId: c.partnerId, mac: c.mac } }) },
                { label: "Excluir", danger: true, hidden: !c.clientId, onClick: () => remove(c) },
              ]} />)}</td>
          </tr>))}</tbody>
      </Table>
      <Empty loading={list.loading} error={list.error} count={list.data.length} />
      <Pager meta={list.meta} onPage={list.setPage} />
      {webFor && <NewWebAccess admin initial={{ mac: webFor.mac, label: webFor.name || undefined, partnerId: webFor.partnerId }} onClose={() => setWebFor(null)} onDone={refresh} />}
      {form && <ClientForm {...form} fixedPartnerId={fixedPartnerId} partners={partners} defaultPartnerId={partnerId} onClose={() => setForm(null)} onSaved={() => { setForm(null); refresh(); }} />}
    </>
  );
}

function ClientForm({ client, prefill, fixedPartnerId, partners, defaultPartnerId, onClose, onSaved }) {
  const run = useAction();
  const { toast } = useUi();
  const edit = !!client;
  const [f, setF] = useState({
    partnerId: client?.partnerId || prefill?.partnerId || fixedPartnerId || defaultPartnerId || "",
    mac: client?.mac || prefill?.mac || "", name: client?.name || "", phone: client?.phone || "", address: client?.address || "", notes: client?.notes || "",
    price: client?.priceCents != null ? (client.priceCents / 100).toFixed(2).replace(".", ",") : "", dueDate: client?.dueDate || "",
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    const mac = formatMac(f.mac);
    if (!mac) return toast("MAC inválido. Use o formato AA:BB:CC:DD:EE:FF.", "bad");
    if (!f.partnerId) return toast("Escolha a revenda.", "bad");
    const priceCents = f.price.trim() === "" ? null : toCents(f.price);
    if (f.price.trim() !== "" && priceCents === null) return toast("Valor inválido. Use números, ex.: 35,00.", "bad");
    const body = { mac, name: f.name, phone: f.phone || null, address: f.address || null, notes: f.notes || null, priceCents, dueDate: f.dueDate || null };
    const r = edit
      ? await run(() => api(`/admin/clients/${client.clientId}`, { method: "PATCH", body: { ...body, ...(f.partnerId !== client.partnerId ? { partnerId: f.partnerId } : {}) } }), "Cliente salvo.")
      : await run(() => api("/admin/clients", { method: "POST", body: { ...body, partnerId: f.partnerId } }), "Cliente cadastrado.");
    if (r) onSaved();
  };
  return (
    <Modal title={edit ? "Editar cliente" : "Novo cliente"} onClose={onClose}>
      {!fixedPartnerId && (
        <Field label="Revenda" hint={edit ? "Trocar a revenda move a ficha (o MAC não pode já ter ficha na revenda de destino)." : undefined}>
          <select value={f.partnerId} onChange={set("partnerId")}>
            <option value="">Selecione…</option>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      )}
      <div className="row"><Field label="Nome"><input value={f.name} onChange={set("name")} /></Field><Field label="MAC"><input value={f.mac} onChange={set("mac")} placeholder="AA:BB:CC:DD:EE:FF" /></Field></div>
      <div className="row"><Field label="Telefone"><input value={f.phone} onChange={set("phone")} /></Field><Field label="Valor mensal (R$)"><input value={f.price} onChange={set("price")} placeholder="35,00" /></Field></div>
      <Field label="Endereço"><input value={f.address} onChange={set("address")} /></Field>
      <Field label="Vencimento"><input type="date" value={f.dueDate} onChange={set("dueDate")} /></Field>
      <Field label="Observações"><textarea rows={3} value={f.notes} onChange={set("notes")} /></Field>
      <div className="actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!f.name || !f.mac} onClick={submit}>Salvar</button></div>
    </Modal>
  );
}

export default function Clients() {
  return (
    <>
      <div className="page-head"><h2>Clientes das revendas</h2></div>
      <ClientsPanel />
    </>
  );
}
