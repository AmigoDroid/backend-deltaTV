import { useState } from "react";
import { api } from "../api.js";
import { Badge, Empty, Field, Modal, Pager, Table, fmtDate, fmtDateTime, fmtMoney, toCents, useAction, useList, useUi } from "../ui.jsx";

export default function Billing() {
  const { confirm, toast } = useUi();
  const run = useAction();
  const [tab, setTab] = useState("invoices");
  const invoices = useList("/admin/billing/invoices", { status: "" });
  const payments = useList("/admin/billing/payments", {});
  const [paying, setPaying] = useState(null);

  const generate = async () => {
    const competence = new Date().toISOString().slice(0, 7);
    const r = await run(() => api("/admin/billing/invoices/generate", { method: "POST", body: { competence } }));
    if (r) { invoices.reload(); toast(`Competência ${r.competence}: ${r.created} cobrança(s) criada(s) para ${r.partners} parceiro(s).`); }
  };
  const sweep = async () => {
    if (!(await confirm({ title: "Aplicar política de inadimplência", message: "Marca faturas vencidas e suspende parcerias com política automática fora da tolerância.", danger: true, confirmLabel: "Aplicar" }))) return;
    const r = await run(() => api("/admin/billing/sweep", { method: "POST" }), "Política aplicada.");
    if (r) invoices.reload();
  };
  const cancel = async (i) => {
    const c = await confirm({ title: "Cancelar fatura", message: `${i.Partner?.name} · ${i.competence}`, reason: "optional", danger: true });
    if (c && (await run(() => api(`/admin/billing/invoices/${i.id}/cancel`, { method: "POST", body: { reason: c.reason } }), "Fatura cancelada."))) invoices.reload();
  };

  return (
    <>
      <div className="page-head"><h2>Financeiro</h2><div className="actions"><button className="btn" onClick={generate}>Gerar cobranças do mês</button><button className="btn danger" onClick={sweep}>Aplicar inadimplência</button></div></div>
      <div className="tabs">{[["invoices", "Cobranças"], ["payments", "Pagamentos"]].map(([k, n]) => <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{n}</button>)}</div>
      {tab === "invoices" && <>
        <div className="toolbar"><select value={invoices.params.status} onChange={(e) => invoices.filter({ status: e.target.value })}>
          <option value="">Todas</option><option value="open">Em aberto</option><option value="partial">Parciais</option><option value="overdue">Vencidas</option><option value="paid">Pagas</option><option value="cancelled">Canceladas</option></select>
          <input type="month" value={invoices.params.competence || ""} onChange={(e) => invoices.filter({ competence: e.target.value })} /></div>
        <Table><thead><tr><th>Parceiro</th><th>Competência</th><th>Dispositivos</th><th>Valor</th><th>Pago</th><th>Vencimento</th><th>Status</th><th /></tr></thead>
          <tbody>{invoices.data.map((i) => (
            <tr key={i.id}><td>{i.Partner?.name}</td><td>{i.competence}</td><td>{i.deviceCount}</td><td>{fmtMoney(i.amountCents)}</td><td>{fmtMoney(i.paidCents)}</td><td>{fmtDate(i.dueDate)}</td><td><Badge status={i.status} /></td>
              <td className="actions">{!["paid", "cancelled"].includes(i.status) && <><button className="btn sm primary" onClick={() => setPaying(i)}>Confirmar pagamento</button>{i.paidCents === 0 && <button className="btn sm danger" onClick={() => cancel(i)}>Cancelar</button>}</>}</td></tr>))}</tbody></Table>
        <Empty loading={invoices.loading} error={invoices.error} count={invoices.data.length} /><Pager meta={invoices.meta} onPage={invoices.setPage} /></>}
      {tab === "payments" && <>
        <Table><thead><tr><th>Data</th><th>Parceiro</th><th>Competência</th><th>Valor</th><th>Forma</th><th>Origem</th></tr></thead>
          <tbody>{payments.data.map((p) => <tr key={p.id}><td>{fmtDateTime(p.paidAt)}</td><td>{p.Invoice?.Partner?.name || "—"}</td><td>{p.Invoice?.competence || "—"}</td><td>{fmtMoney(p.amountCents)}</td><td>{p.method || "—"}</td><td>{p.origin === "webhook" ? `Webhook (${p.provider})` : "Administrador"}</td></tr>)}</tbody></Table>
        <Empty loading={payments.loading} error={payments.error} count={payments.data.length} /><Pager meta={payments.meta} onPage={payments.setPage} /></>}
      {paying && <PayModal invoice={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); invoices.reload(); payments.reload(); }} />}
    </>
  );
}

function PayModal({ invoice, onClose, onDone }) {
  const run = useAction();
  const remaining = invoice.amountCents - invoice.paidCents;
  const [amount, setAmount] = useState((remaining / 100).toFixed(2).replace(".", ","));
  const [method, setMethod] = useState("pix");
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  const { toast } = useUi();
  const submit = async () => {
    const amountCents = toCents(amount);
    if (!amountCents || amountCents <= 0) return toast("Valor inválido. Use um número maior que zero, ex.: 1.234,56.", "bad");
    const r = await run(() => api(`/admin/billing/invoices/${invoice.id}/payments`, { method: "POST", body: { amountCents, method, reference: ref || undefined, note: note || undefined } }),
      "Pagamento confirmado.");
    if (r) onDone();
  };
  return (
    <Modal title={`Confirmar pagamento · ${invoice.Partner?.name} · ${invoice.competence}`} onClose={onClose}>
      <p className="muted">Confirmação administrativa (auditada). Para confirmação automática use o webhook do provedor de pagamento. Saldo: {fmtMoney(remaining)}.</p>
      <div className="row"><Field label="Valor (R$)"><input value={amount} onChange={(e) => setAmount(e.target.value)} /></Field><Field label="Forma"><input value={method} onChange={(e) => setMethod(e.target.value)} /></Field></div>
      <Field label="Referência / comprovante" hint="Evita lançamento duplicado do mesmo comprovante"><input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
      <Field label="Observação"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Confirmar</button></div>
    </Modal>
  );
}
