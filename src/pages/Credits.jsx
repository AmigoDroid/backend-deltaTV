import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Badge, Empty, Field, LoadError, Modal, Pager, Table, fmtDateTime, fmtMoney, toCents, useAction, useDebounced, useList, useLoad, useUi } from "../ui.jsx";

const monthsLabel = (m) => `${m} ${m === 1 ? "mês" : "meses"}`;
const creditsLabel = (n) => `${n} ${Math.abs(n) === 1 ? "crédito" : "créditos"}`;
const KIND = { topup: "Recarga Pix", purchase: "Compra de licença", adjust: "Ajuste" };
const brl = (cents) => (cents / 100).toFixed(2).replace(".", ",");

// Revendedores/parceiros que têm carteira (quem compra licença para estoque).
function useResellers() {
  const partners = useLoad(() => api("/admin/partners", { query: { pageSize: 100 } }), []);
  return (partners.data?.data ?? []).filter((p) => ["reseller", "both"].includes(p.kind));
}

/**
 * Créditos (admin): saldo pré-pago que o revendedor usa SÓ para comprar licenças. Aqui você define o câmbio
 * (quanto vale 1 crédito em R$), o preço de cada licença em créditos e ajusta saldos. Não há transferência entre
 * revendedores nem saque: o crédito entra por Pix (ou por você) e sai comprando licença.
 */
export default function Credits() {
  const [tab, setTab] = useState("wallets");
  const [ledgerPartner, setLedgerPartner] = useState("");
  const rates = useLoad(() => api("/admin/credits/rates"), []);
  const tabs = [["wallets", "Carteiras"], ["rates", "Câmbio"], ["prices", "Preços em crédito"], ["ledger", "Extrato"]];
  const openLedger = (partnerId) => { setLedgerPartner(partnerId); setTab("ledger"); };
  return (
    <>
      <div className="page-head"><h2>Créditos</h2></div>
      {rates.data && !rates.data.general && (
        <div className="card" style={{ padding: 12, marginBottom: 12, borderColor: "var(--warn)" }}>
          <strong>Câmbio geral não definido.</strong> <span className="muted">Enquanto não houver câmbio, os revendedores não conseguem recarregar créditos por Pix (só você pode lançar crédito). Defina na aba Câmbio.</span>
        </div>
      )}
      <div className="tabs">{tabs.map(([k, n]) => <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{n}</button>)}</div>
      {tab === "wallets" && <Wallets onLedger={openLedger} />}
      {tab === "rates" && <Rates data={rates.data} error={rates.error} reload={rates.reload} />}
      {tab === "prices" && <Prices />}
      {tab === "ledger" && <Ledger initialPartner={ledgerPartner} key={ledgerPartner} />}
    </>
  );
}

/* ---------------- Carteiras ---------------- */

function Wallets({ onLedger }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const list = useList("/admin/credits/wallets", {});
  const { filter } = list;
  const [adjust, setAdjust] = useState(null);
  useEffect(() => { filter({ q: dq }); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <p className="muted">Saldo de créditos de cada revendedor. Use <strong>Ajustar</strong> para dar crédito (cortesia, pagamento fora do Pix) ou remover (correção/estorno).</p>
      <div className="toolbar"><input placeholder="Buscar revendedor" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar revendedor" /></div>
      <Table>
        <thead><tr><th>Revendedor</th><th>Situação</th><th>Saldo</th><th /></tr></thead>
        <tbody>{list.data.map((w) => (
          <tr key={w.id}>
            <td>{w.name}</td><td><Badge status={w.status} /></td><td><strong>{w.balance}</strong> <span className="muted">{w.balance === 1 ? "crédito" : "créditos"}</span></td>
            <td className="actions">
              <button className="btn sm" onClick={() => onLedger(w.id)}>Extrato</button>
              <button className="btn sm primary" onClick={() => setAdjust(w)}>Ajustar</button>
            </td>
          </tr>))}</tbody>
      </Table>
      <Empty loading={list.loading} error={list.error} count={list.data.length} />
      <Pager meta={list.meta} onPage={list.setPage} />
      {adjust && <AdjustModal wallet={adjust} onClose={() => setAdjust(null)} onDone={() => { setAdjust(null); list.reload(); }} />}
    </>
  );
}

function AdjustModal({ wallet, onClose, onDone }) {
  const run = useAction();
  const { toast } = useUi();
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const d = Number(delta);
  const valid = Number.isInteger(d) && d !== 0 && note.trim().length >= 3;
  const submit = async () => {
    if (!valid) return toast("Informe os créditos (diferente de zero) e o motivo.", "bad");
    const r = await run(() => api(`/admin/credits/wallets/${wallet.id}/adjust`, { method: "POST", body: { delta: d, note: note.trim() } }), "Saldo ajustado.");
    if (r) onDone();
  };
  return (
    <Modal title={`Ajustar saldo · ${wallet.name}`} onClose={onClose}>
      <p className="muted">Saldo atual: <strong>{creditsLabel(wallet.balance)}</strong>. {Number.isInteger(d) && d !== 0 && wallet.balance + d >= 0 && <>Ficará com <strong>{creditsLabel(wallet.balance + d)}</strong>.</>}</p>
      <Field label="Créditos" hint="Positivo dá crédito; negativo remove. O saldo nunca fica abaixo de zero."><input type="number" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="ex.: 50 ou -10" /></Field>
      <Field label="Motivo" hint="Fica registrado no extrato e na auditoria."><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
      <div className="actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!valid} onClick={submit}>Aplicar</button></div>
    </Modal>
  );
}

/* ---------------- Câmbio ---------------- */

function Rates({ data, error, reload }) {
  const { confirm } = useUi();
  const run = useAction();
  const resellers = useResellers();
  const [edit, setEdit] = useState(null); // { partnerId, partnerName, value, fixedPartner }
  if (error) return <LoadError error={error} onRetry={reload} />;
  if (!data) return <p className="muted">Carregando…</p>;
  const remove = async (r) => {
    if (!(await confirm({ title: "Remover câmbio", message: r.partnerId ? `O câmbio de ${r.partnerName} volta a ser o geral.` : "Sem câmbio geral, ninguém consegue recarregar por Pix.", danger: true }))) return;
    if (await run(() => api(`/admin/credits/rates/${r.id}`, { method: "DELETE" }), "Câmbio removido.")) reload();
  };
  return (
    <>
      <p className="muted">O câmbio é <strong>quanto vale 1 crédito em reais</strong> na hora da recarga por Pix. O revendedor escolhe quantos créditos quer e o servidor calcula o valor (créditos × câmbio). Mudar o câmbio só vale para as próximas recargas; o histórico guarda o câmbio usado.</p>
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <small className="muted">Câmbio geral</small>
        <div style={{ fontSize: 26, fontWeight: 700 }}>{data.general ? `1 crédito = ${fmtMoney(data.general.rateCents)}` : "Não definido"}</div>
        <div className="actions left" style={{ marginTop: 8 }}>
          <button className="btn primary" onClick={() => setEdit({ partnerId: "", value: data.general ? brl(data.general.rateCents) : "" })}>{data.general ? "Alterar" : "Definir câmbio"}</button>
          {data.general && <button className="btn danger" onClick={() => remove(data.general)}>Remover</button>}
        </div>
      </div>
      <div className="section-head"><h3>Câmbio combinado com um revendedor</h3><button className="btn" onClick={() => setEdit({ partnerId: "", value: "", custom: true })}>Novo câmbio combinado</button></div>
      <Table>
        <thead><tr><th>Revendedor</th><th>1 crédito vale</th><th /></tr></thead>
        <tbody>{data.custom.map((r) => (
          <tr key={r.id}>
            <td>{r.partnerName}</td><td>{fmtMoney(r.rateCents)}</td>
            <td className="actions">
              <button className="btn sm" onClick={() => setEdit({ partnerId: r.partnerId, partnerName: r.partnerName, value: brl(r.rateCents), custom: true, locked: true })}>Editar</button>
              <button className="btn sm danger" onClick={() => remove(r)}>Remover</button>
            </td>
          </tr>))}</tbody>
      </Table>
      <Empty loading={false} error="" count={data.custom.length} />
      {edit && <RateModal value={edit} resellers={resellers} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function RateModal({ value, resellers, onClose, onSaved }) {
  const run = useAction();
  const { toast } = useUi();
  const [partnerId, setPartnerId] = useState(value.partnerId);
  const [price, setPrice] = useState(value.value);
  const submit = async () => {
    const rateCents = toCents(price);
    if (!rateCents || rateCents <= 0) return toast("Valor inválido. Use um valor maior que zero, ex.: 1,00.", "bad");
    if (value.custom && !partnerId) return toast("Escolha o revendedor.", "bad");
    const r = await run(() => api("/admin/credits/rates", { method: "PUT", body: { partnerId: value.custom ? partnerId : null, rateCents } }), "Câmbio salvo.");
    if (r) onSaved();
  };
  return (
    <Modal title={value.custom ? "Câmbio combinado" : "Câmbio geral"} onClose={onClose}>
      {value.custom && (
        <Field label="Revendedor">
          <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)} disabled={!!value.locked}>
            <option value="">Escolha…</option>
            {resellers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="1 crédito vale (R$)" hint="Valor cobrado por crédito na recarga por Pix."><input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="1,00" inputMode="decimal" /></Field>
      <div className="actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Salvar</button></div>
    </Modal>
  );
}

/* ---------------- Preços em crédito ---------------- */

function Prices() {
  const { confirm } = useUi();
  const run = useAction();
  const [partnerId, setPartnerId] = useState("");
  const resellers = useResellers();
  const prices = useLoad(() => api("/admin/credits/prices", { query: { partnerId } }), [partnerId]);
  const [edit, setEdit] = useState(null);
  const remove = async (p) => {
    if (!(await confirm({ title: "Remover preço", message: `${monthsLabel(p.months)} — ${creditsLabel(p.priceCredits)}`, danger: true }))) return;
    if (await run(() => api(`/admin/credits/prices/${p.id}`, { method: "DELETE" }), "Preço removido.")) prices.reload();
  };
  return (
    <>
      <p className="muted">Quantos <strong>créditos custa 1 licença</strong> de cada duração. Só o que estiver aqui aparece para o revendedor comprar com crédito.</p>
      <div className="toolbar">
        <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)} aria-label="Escopo dos preços">
          <option value="">Tabela geral (todos os revendedores)</option>
          {resellers.map((p) => <option key={p.id} value={p.id}>Preço combinado: {p.name}</option>)}
        </select>
        <button className="btn primary" onClick={() => setEdit({ months: "", price: "", active: true, isNew: true })}>Novo preço</button>
      </div>
      {partnerId && <p className="muted">Estes preços valem só para este revendedor e sobrepõem a tabela geral. Desmarcar “à venda” esconde a duração para ele.</p>}
      {prices.error && <LoadError error={prices.error} onRetry={prices.reload} />}
      <Table>
        <thead><tr><th>Duração</th><th>Preço (cada)</th><th>À venda</th><th /></tr></thead>
        <tbody>{(prices.data?.data ?? []).map((p) => (
          <tr key={p.id}>
            <td>{monthsLabel(p.months)}</td><td>{creditsLabel(p.priceCredits)}</td><td>{p.active ? "Sim" : "Não"}</td>
            <td className="actions">
              <button className="btn sm" onClick={() => setEdit({ months: String(p.months), price: String(p.priceCredits), active: p.active })}>Editar</button>
              <button className="btn sm danger" onClick={() => remove(p)}>Remover</button>
            </td>
          </tr>))}</tbody>
      </Table>
      <Empty loading={!prices.data && !prices.error} error="" count={prices.data ? prices.data.data.length : 1} />
      {edit && <PriceModal value={edit} partnerId={partnerId} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); prices.reload(); }} />}
    </>
  );
}

function PriceModal({ value, partnerId, onClose, onSaved }) {
  const run = useAction();
  const { toast } = useUi();
  const [months, setMonths] = useState(value.months);
  const [price, setPrice] = useState(value.price);
  const [active, setActive] = useState(value.active);
  const submit = async () => {
    const m = Number(months);
    const priceCredits = Number(price);
    if (!Number.isInteger(m) || m < 1 || m > 120) return toast("Informe a duração em meses (1 a 120).", "bad");
    if (!Number.isInteger(priceCredits) || priceCredits < 1) return toast("Preço inválido. Use um número inteiro de créditos, maior que zero.", "bad");
    const r = await run(() => api("/admin/credits/prices", { method: "PUT", body: { partnerId: partnerId || null, months: m, priceCredits, active } }), "Preço salvo.");
    if (r) onSaved();
  };
  return (
    <Modal title={value.isNew ? "Novo preço" : `Preço de ${monthsLabel(Number(value.months))}`} onClose={onClose}>
      <div className="row">
        <Field label="Duração (meses)"><input type="number" min="1" max="120" value={months} onChange={(e) => setMonths(e.target.value)} disabled={!value.isNew} /></Field>
        <Field label="Preço de 1 licença (créditos)"><input type="number" min="1" step="1" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="ex.: 10" /></Field>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> À venda por crédito</label>
      <div className="actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Salvar</button></div>
    </Modal>
  );
}

/* ---------------- Extrato ---------------- */

function Ledger({ initialPartner }) {
  const resellers = useResellers();
  const list = useList("/admin/credits/ledger", initialPartner ? { partnerId: initialPartner } : {});
  return (
    <>
      <div className="toolbar">
        <select value={list.params.partnerId ?? ""} onChange={(e) => list.filter({ partnerId: e.target.value })} aria-label="Revendedor">
          <option value="">Todos os revendedores</option>
          {resellers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={list.params.kind ?? ""} onChange={(e) => list.filter({ kind: e.target.value })} aria-label="Movimento">
          <option value="">Todos os movimentos</option>
          {Object.entries(KIND).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
        </select>
      </div>
      <Table>
        <thead><tr><th>Quando</th><th>Revendedor</th><th>Movimento</th><th>Créditos</th><th>Saldo</th><th>Detalhe</th><th>Quem</th></tr></thead>
        <tbody>{list.data.map((r) => (
          <tr key={r.id}>
            <td>{fmtDateTime(r.at)}</td><td>{r.partner?.name ?? "—"}</td><td>{KIND[r.kind] || r.kind}</td>
            <td style={{ color: r.delta > 0 ? "var(--ok)" : undefined }}>{r.delta > 0 ? `+${r.delta}` : r.delta}</td>
            <td>{r.balanceAfter}</td>
            <td className="wrap">{[
              r.kind === "purchase" ? `${r.quantity} × ${monthsLabel(r.months)} (${creditsLabel(r.unitPriceCredits)} cada)` : null,
              r.kind === "topup" && r.rateCents ? `1 crédito = ${fmtMoney(r.rateCents)}` : null,
              r.kind === "adjust" ? r.note : null,
            ].filter(Boolean).join(" · ") || "—"}</td>
            <td>{r.actorName || "—"}</td>
          </tr>))}</tbody>
      </Table>
      <Empty loading={list.loading} error={list.error} count={list.data.length} />
      <Pager meta={list.meta} onPage={list.setPage} />
    </>
  );
}
