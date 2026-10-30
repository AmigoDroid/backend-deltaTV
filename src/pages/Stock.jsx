import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Badge, Empty, Field, LoadError, Modal, Pager, Table, fmtDate, fmtDateTime, fmtMoney, toCents, useAction, useLoad, useUi } from "../ui.jsx";

export const monthsLabel = (m) => `${m} ${m === 1 ? "mês" : "meses"}`;
const QUICK = [1, 3, 6, 12];
const changed = () => window.dispatchEvent(new Event("stock-changed"));

const KIND = { grant: "Entrada", adjust: "Ajuste", transfer_in: "Recebida de", transfer_out: "Enviada para", consume: "Aplicada em cliente" };

/** Duração em meses (1–120) com atalhos. `value` é texto; o chamador converte com Number(). */
function MonthsField({ value, onChange, label = "Duração (meses)", hint = "De 1 a 120 meses." }) {
  return (
    <Field label={label} hint={hint}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <input type="number" min="1" max="120" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 90 }} />
        {QUICK.map((m) => <button type="button" key={m} className="btn sm" onClick={() => onChange(String(m))}>{monthsLabel(m)}</button>)}
      </div>
    </Field>
  );
}
const validMonths = (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 120;

function Balances({ balances }) {
  if (!balances.length) return <p className="muted">Estoque vazio.</p>;
  return (
    <div className="grid cards">
      {balances.map((b) => <div className="card stat" key={b.months}><small>{monthsLabel(b.months)}</small><strong>{b.quantity}</strong><span>licença(s)</span></div>)}
    </div>
  );
}

function Ledger({ ledger, onPage, admin }) {
  return (
    <>
      <Table>
        <thead><tr><th>Quando</th><th>Movimento</th><th>Duração</th><th>Qtd.</th><th>Saldo</th><th>Detalhe</th>{admin && <th>Quem</th>}</tr></thead>
        <tbody>{ledger.data.map((r) => (
          <tr key={r.id}>
            <td>{fmtDateTime(r.at)}</td>
            <td>{KIND[r.kind] || r.kind}{r.counterparty ? ` ${r.counterparty.name}` : ""}</td>
            <td>{monthsLabel(r.months)}</td>
            <td style={{ color: r.delta > 0 ? "var(--ok)" : undefined }}>{r.delta > 0 ? `+${r.delta}` : r.delta}</td>
            <td>{r.balanceAfter}</td>
            <td>{[r.unitPriceCents != null ? `${fmtMoney(r.unitPriceCents)} cada` : null, r.note].filter(Boolean).join(" · ") || "—"}</td>
            {admin && <td>{r.actorName || "—"}</td>}
          </tr>))}</tbody>
      </Table>
      <Empty loading={false} error="" count={ledger.data.length} />
      <Pager meta={ledger.meta} onPage={onPage} />
    </>
  );
}

/* ================= Painel admin: aba "Estoque" do revendedor ================= */

export function StockAdmin({ partnerId }) {
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(null); // "grant" | "adjust"
  const { data, error, reload } = useLoad(() => api(`/admin/partners/${partnerId}/stock`, { query: { page, pageSize: 15 } }), [partnerId, page]);
  if (!data) return error ? <LoadError error={error} onRetry={reload} /> : <p className="muted">Carregando…</p>;
  return (
    <>
      <p className="muted">Licenças que este revendedor pode aplicar em clientes (por MAC) ou transferir para outros revendedores. Você lança o estoque manualmente depois de receber o pagamento.</p>
      <Balances balances={data.balances} />
      <div className="actions left" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={() => setModal("grant")}>Lançar licenças</button>
        <button className="btn" onClick={() => setModal("adjust")}>Ajustar estoque</button>
      </div>
      <h4>Extrato</h4>
      <Ledger ledger={data.ledger} onPage={setPage} admin />
      {modal === "grant" && <GrantModal partnerId={partnerId} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === "adjust" && <AdjustModal partnerId={partnerId} balances={data.balances} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
    </>
  );
}

function GrantModal({ partnerId, onClose, onDone }) {
  const run = useAction();
  const { toast } = useUi();
  const [months, setMonths] = useState("1");
  const [quantity, setQuantity] = useState("10");
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  const submit = async () => {
    const unitPriceCents = price.trim() ? toCents(price) : undefined;
    if (price.trim() && unitPriceCents === null) return toast("Valor inválido. Use números, ex.: 15,00.", "bad");
    const body = { months: Number(months), quantity: Number(quantity), unitPriceCents, note: note.trim() || undefined };
    if (await run(() => api(`/admin/partners/${partnerId}/stock/grant`, { method: "POST", body }), "Licenças lançadas no estoque.")) onDone();
  };
  const ok = validMonths(months) && Number.isInteger(Number(quantity)) && Number(quantity) >= 1 && Number(quantity) <= 10000;
  return (
    <Modal title="Lançar licenças no estoque" onClose={onClose}>
      <MonthsField value={months} onChange={setMonths} />
      <div className="row">
        <Field label="Quantidade"><input type="number" min="1" max="10000" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
        <Field label="Valor por licença (R$)" hint="Opcional; fica só no extrato"><input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="15,00" /></Field>
      </div>
      <Field label="Observação" hint="Ex.: Pix recebido em 25/10"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      <div className="actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!ok} onClick={submit}>Lançar</button></div>
    </Modal>
  );
}

function AdjustModal({ partnerId, balances, onClose, onDone }) {
  const run = useAction();
  const [months, setMonths] = useState(String(balances[0]?.months ?? 1));
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const current = balances.find((b) => b.months === Number(months))?.quantity ?? 0;
  const submit = async () => {
    const body = { months: Number(months), delta: Number(delta), note: note.trim() };
    if (await run(() => api(`/admin/partners/${partnerId}/stock/adjust`, { method: "POST", body }), "Estoque ajustado.")) onDone();
  };
  const d = Number(delta);
  const ok = validMonths(months) && Number.isInteger(d) && d !== 0 && Math.abs(d) <= 10000 && current + d >= 0 && note.trim().length >= 3;
  return (
    <Modal title="Ajustar estoque" onClose={onClose}>
      <p className="muted">Correção manual. Use número negativo para tirar licenças (o saldo não pode ficar abaixo de zero).</p>
      <MonthsField value={months} onChange={setMonths} />
      <p className="muted">Saldo atual de {monthsLabel(Number(months) || 0)}: <strong>{current}</strong></p>
      <Field label="Quantidade (+ ou −)"><input type="number" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="-2" /></Field>
      <Field label="Motivo (obrigatório)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      <div className="actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!ok} onClick={submit}>Ajustar</button></div>
    </Modal>
  );
}

/* ================= Admin: criar plano com duração livre ================= */

export function NewPlanInline({ onCreated }) {
  const run = useAction();
  const [months, setMonths] = useState("");
  const create = async () => {
    const plan = await run(() => api("/admin/licenses/plans", { method: "POST", body: { months: Number(months) } }), "Plano pronto.");
    if (plan && plan !== true) { setMonths(""); onCreated(plan); }
  };
  return (
    <Field label="Outra duração" hint="Cria (ou reaproveita) o plano de N meses, de 1 a 120.">
      <div style={{ display: "flex", gap: 6 }}>
        <input type="number" min="1" max="120" value={months} onChange={(e) => setMonths(e.target.value)} placeholder="meses" style={{ width: 90 }} />
        <button type="button" className="btn" disabled={!validMonths(months)} onClick={create}>Criar plano</button>
      </div>
    </Field>
  );
}
