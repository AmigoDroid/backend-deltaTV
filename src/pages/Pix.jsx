import { useState } from "react";
import { api } from "../api.js";
import { Badge, Empty, Field, LoadError, Modal, Pager, Table, fmtDateTime, fmtMoney, toCents, useAction, useList, useLoad, useUi } from "../ui.jsx";

const monthsLabel = (m) => `${m} ${m === 1 ? "mês" : "meses"}`;
const what = (c) => (c.purpose === "invoice" ? `Mensalidade ${c.invoice?.competence ?? ""}`.trim() : c.purpose === "license" ? `Licença de ${monthsLabel(c.months)} (site) · ${c.mac ?? ""}` : c.purpose === "credit" ? `${c.quantity} crédito(s) (recarga)` : `${c.quantity} licença(s) de ${monthsLabel(c.months)}`);
const ChargeBadge = ({ status }) => (status === "pending" ? <Badge status="info" label="Aguardando" /> : <Badge status={status} />);

/**
 * Pix (admin): o dinheiro entra direto pelo provedor (Mercado Pago) e a entrega é automática.
 * Esta tela serve para acompanhar, tratar o que caiu em "conferência" e definir os PREÇOS das licenças.
 */
export default function Pix() {
  const [tab, setTab] = useState("charges");
  const cfg = useLoad(() => api("/admin/pix/config"), []);
  const review = useLoad(() => api("/admin/pix/charges", { query: { status: "review", pageSize: 1 } }), []);
  const reviewCount = review.data?.meta?.total ?? 0;

  return (
    <>
      <div className="page-head"><h2>Pix</h2></div>
      {cfg.error && <LoadError error={cfg.error} onRetry={cfg.reload} />}
      {cfg.data && !cfg.data.enabled && (
        <div className="card" style={{ padding: 16, marginBottom: 12 }}>
          <strong>Pix desligado.</strong> <span className="muted">Defina <span className="mono">PIX_PROVIDER=mercadopago</span>, <span className="mono">MP_ACCESS_TOKEN</span> e <span className="mono">MP_WEBHOOK_SECRET</span> no <span className="mono">.env</span> do servidor e reinicie. Enquanto isso, os revendedores não veem o botão de pagar.</span>
        </div>
      )}
      {cfg.data?.enabled && (
        <p className="muted" style={{ marginTop: 0 }}>
          Provedor: <strong>{cfg.data.provider === "mock" ? "TESTE (simulado)" : "Mercado Pago"}</strong> · QR Code válido por {cfg.data.expirationMinutes} min
          {cfg.data.webhookUrl ? <> · URL do webhook: <span className="mono">{cfg.data.webhookUrl}</span></> : cfg.data.provider === "mercadopago" ? <> · <span className="error">sem URL pública (PUBLIC_BASE_URL aponta para localhost): a confirmação depende da conferência automática a cada 2 min</span></> : null}
        </p>
      )}
      {reviewCount > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 12, borderColor: "var(--warn)" }}>
          <strong>{reviewCount} pagamento(s) em conferência:</strong> o dinheiro chegou, mas não foi possível entregar automaticamente (valor diferente, fatura já quitada ou cadastro bloqueado). Veja abaixo.
        </div>
      )}
      <div className="tabs">{[["charges", "Cobranças Pix"], ["prices", "Preços das licenças"]].map(([k, n]) => <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{n}</button>)}</div>
      {tab === "charges" && <Charges provider={cfg.data?.provider} onChanged={review.reload} />}
      {tab === "prices" && <Prices />}
    </>
  );
}

function Charges({ provider, onChanged }) {
  const { confirm } = useUi();
  const run = useAction();
  const list = useList("/admin/pix/charges", { status: "", purpose: "" });

  const act = async (fn, ok) => { if (await run(fn, ok)) { list.reload(); onChanged(); } };
  const reprocess = (c) => act(() => api(`/admin/pix/charges/${c.id}/reprocess`, { method: "POST" }), "Cobrança reconsultada no provedor.");
  const simulate = (c) => act(() => api(`/admin/pix/charges/${c.id}/simulate-payment`, { method: "POST" }), "Pagamento simulado.");
  const resolve = async (c) => {
    const r = await confirm({
      title: "Resolver manualmente",
      message: `${c.partner?.name} · ${what(c)} · ${fmtMoney(c.paidAmountCents ?? c.amountCents)}. Faça isso só depois de lançar o estoque/pagamento à mão e/ou devolver o dinheiro.`,
      reason: "required", confirmLabel: "Marcar como resolvido",
    });
    if (r) act(() => api(`/admin/pix/charges/${c.id}/resolve`, { method: "POST", body: { note: r.reason } }), "Cobrança resolvida.");
  };

  return (
    <>
      <div className="toolbar">
        <select value={list.params.status} onChange={(e) => list.filter({ status: e.target.value })}>
          <option value="">Todos os status</option><option value="review">Em conferência</option><option value="pending">Aguardando</option>
          <option value="paid">Pagos</option><option value="expired">Expirados</option><option value="cancelled">Cancelados</option><option value="refunded">Devolvidos</option><option value="failed">Falharam</option>
        </select>
        <select value={list.params.purpose} onChange={(e) => list.filter({ purpose: e.target.value })}>
          <option value="">Mensalidades e licenças</option><option value="invoice">Mensalidades</option><option value="stock">Compra de licenças</option><option value="license">Licenças do site</option>
        </select>
      </div>
      <Table>
        <thead><tr><th>Data</th><th>Parceiro</th><th>Referente a</th><th>Valor</th><th>Status</th><th>Pago em</th><th /></tr></thead>
        <tbody>{list.data.map((c) => (
          <tr key={c.id}>
            <td>{fmtDateTime(c.createdAt)}</td>
            <td>{c.partner?.name || (c.purpose === "license" ? "Site (cliente)" : "—")}</td>
            <td>{what(c)}</td>
            <td>{fmtMoney(c.amountCents)}{c.paidAmountCents != null && c.paidAmountCents !== c.amountCents && <div className="error">pago: {fmtMoney(c.paidAmountCents)}</div>}</td>
            <td><ChargeBadge status={c.status} />{c.error && <div className="muted" style={{ maxWidth: 320, fontSize: 12 }}>{c.error}</div>}</td>
            <td>{c.paidAt ? fmtDateTime(c.paidAt) : "—"}</td>
            <td className="actions">
              {["review", "pending", "expired", "cancelled"].includes(c.status) && c.providerRef && <button className="btn sm" onClick={() => reprocess(c)}>Reconsultar</button>}
              {c.status === "review" && <button className="btn sm primary" onClick={() => resolve(c)}>Resolver</button>}
              {provider === "mock" && c.status === "pending" && <button className="btn sm" onClick={() => simulate(c)}>Simular pagamento</button>}
            </td>
          </tr>))}</tbody>
      </Table>
      <Empty loading={list.loading} error={list.error} count={list.data.length} />
      <Pager meta={list.meta} onPage={list.setPage} />
    </>
  );
}

/** Preços de venda das licenças: tabela geral e preços combinados com um revendedor (sobrepõem a geral). */
function Prices() {
  const { confirm } = useUi();
  const run = useAction();
  const [partnerId, setPartnerId] = useState("");
  const partners = useLoad(() => api("/admin/partners", { query: { pageSize: 100 } }), []);
  const prices = useLoad(() => api("/admin/pix/prices", { query: { partnerId } }), [partnerId]);
  const [edit, setEdit] = useState(null); // { months, price, active } (months fixo ao editar)
  const resellers = (partners.data?.data ?? []).filter((p) => ["reseller", "both"].includes(p.kind));

  const remove = async (p) => {
    if (!(await confirm({ title: "Remover preço", message: `${monthsLabel(p.months)} — ${fmtMoney(p.priceCents)}`, danger: true }))) return;
    if (await run(() => api(`/admin/pix/prices/${p.id}`, { method: "DELETE" }), "Preço removido.")) prices.reload();
  };

  return (
    <>
      <p className="muted">Preço de <strong>1 licença</strong> por duração. Só o que estiver aqui aparece para o revendedor comprar por Pix. O valor cobrado é sempre calculado pelo servidor.</p>
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
            <td>{monthsLabel(p.months)}</td><td>{fmtMoney(p.priceCents)}</td><td>{p.active ? "Sim" : "Não"}</td>
            <td className="actions">
              <button className="btn sm" onClick={() => setEdit({ months: String(p.months), price: (p.priceCents / 100).toFixed(2).replace(".", ","), active: p.active })}>Editar</button>
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
    const priceCents = toCents(price);
    if (!Number.isInteger(m) || m < 1 || m > 120) return toast("Informe a duração em meses (1 a 120).", "bad");
    if (!priceCents || priceCents <= 0) return toast("Preço inválido. Use um valor maior que zero, ex.: 25,00.", "bad");
    const r = await run(() => api("/admin/pix/prices", { method: "PUT", body: { partnerId: partnerId || null, months: m, priceCents, active } }), "Preço salvo.");
    if (r) onSaved();
  };
  return (
    <Modal title={value.isNew ? "Novo preço" : `Preço de ${monthsLabel(Number(value.months))}`} onClose={onClose}>
      <div className="row">
        <Field label="Duração (meses)"><input type="number" min="1" max="120" value={months} onChange={(e) => setMonths(e.target.value)} disabled={!value.isNew} /></Field>
        <Field label="Preço de 1 licença (R$)"><input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="25,00" inputMode="decimal" /></Field>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> À venda por Pix</label>
      <div className="actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Salvar</button></div>
    </Modal>
  );
}
