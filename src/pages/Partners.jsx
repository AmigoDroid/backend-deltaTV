import { useEffect, useState } from "react";
import { api, getAuth } from "../api.js";
import { ClientsPanel } from "./Clients.jsx";
import { NewWebAccess } from "./WebAccess.jsx";
import { UsersPanel } from "./Users.jsx";
import CodeModal, { CodeEditModal } from "./CodeModal.jsx";
import { StockAdmin } from "./Stock.jsx";
import { Badge, DeliveryBadge, accessStatus, Empty, Field, LoadError, Modal, Pager, RowMenu, Table, dateInput, fmtDate, fmtDateTime, fmtMoney, spDateToIso, toCents, useAction, useDebounced, useList, useLoad, useUi } from "../ui.jsx";

// Mesmo texto gravado pelo back-end no autocadastro de revendedor (ver reseller-signup.service.js).
const PENDING_REASON = "Aguardando aprovação do cadastro";
export const isPending = (p) => p.status === "suspended" && p.statusReason === PENDING_REASON;

const MODELS = { none: "Sem mensalidade", fixed: "Mensalidade fixa", per_device: "Por dispositivo ativo", tiered: "Por faixa de dispositivos" };

const KIND_LABEL = { content: "Parceiro (conteúdo)", reseller: "Revenda", both: "Parceiro e revenda" };

// Parceiro = provedor de conteúdo (servidores IPTV + códigos). Revenda = quem compra licenças, tem estoque e atende clientes por MAC.
// "both" aparece nas duas telas, com uma etiqueta avisando que também pertence à outra.
const SCOPES = {
  content: {
    title: "Parceiros", sub: "Provedores de conteúdo: servidores IPTV, códigos de ativação e mensalidade.",
    kinds: ["content", "both"], defaultKind: "content", newLabel: "Novo parceiro", noun: "parceiro", saved: "Parceiro salvo.",
    search: "Buscar parceiro por nome ou identificador", also: "também é revenda", billing: "Modelo",
  },
  reseller: {
    title: "Revendas", sub: "Quem compra licenças, mantém estoque e atende os clientes finais por MAC.",
    kinds: ["reseller", "both"], defaultKind: "reseller", newLabel: "Nova revenda", noun: "revenda", saved: "Revenda salva.",
    search: "Buscar revenda por nome ou identificador", also: "também é parceiro", billing: "Cobrança",
  },
};

function PartnersList({ scope, onChanged }) {
  const cfg = SCOPES[scope];
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const list = useList("/admin/partners", { q: "", status: "", pageSize: 100 });
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  useEffect(() => { list.filter({ q: dq }); /* eslint-disable-next-line */ }, [dq]);
  const rows = list.data.filter((p) => cfg.kinds.includes(p.kind));
  const changed = () => { list.reload(); onChanged?.(); };
  const count = (fn) => rows.filter(fn).length;
  const pending = count(isPending);
  return (
    <>
      <div className="page-head">
        <div><h2>{cfg.title}</h2><p className="muted page-sub">{cfg.sub}</p></div>
        <button className="btn primary" onClick={() => setCreating(true)}>+ {cfg.newLabel}</button>
      </div>
      {rows.length > 0 && (
        <div className="mini-stats">
          <div><strong>{rows.length}</strong><span>listados</span></div>
          <div><strong>{count((p) => p.effectiveStatus === "active")}</strong><span>ativos</span></div>
          {pending > 0 && <div className="warn"><strong>{pending}</strong><span>aguardando aprovação</span></div>}
          <div><strong>{count((p) => ["suspended", "blocked"].includes(p.effectiveStatus) && !isPending(p))}</strong><span>suspensos ou bloqueados</span></div>
        </div>
      )}
      <div className="toolbar">
        <input placeholder={cfg.search} value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={list.params.status} onChange={(e) => list.filter({ status: e.target.value })}>
          <option value="">Todos os status</option><option value="pending">Aguardando aprovação</option><option value="active">Ativos</option><option value="expired">Expirados</option><option value="suspended">Suspensos</option><option value="blocked">Bloqueados</option><option value="cancelled">Cancelados</option>
        </select>
      </div>
      <Table>
        <thead><tr><th>{scope === "reseller" ? "Revenda" : "Parceiro"}</th><th>Status</th><th>{cfg.billing}</th><th>Dispositivos</th><th>Término</th></tr></thead>
        <tbody>{rows.map((p) => (
          <tr key={p.id} className="click" onClick={() => setOpenId(p.id)}>
            <td><strong>{p.name}</strong><div className="muted">{p.slug}{p.kind === "both" && <span className="kind both">{cfg.also}</span>}</div></td>
            <td>{isPending(p) ? <Badge status="pending" label="Novo cadastro" /> : <Badge status={p.effectiveStatus} />}</td>
            <td>{MODELS[p.billingModel]}</td><td>{p.deviceCount}{p.deviceLimit != null ? `/${p.deviceLimit}` : ""}</td><td>{fmtDate(p.endsAt)}</td>
          </tr>))}</tbody>
      </Table>
      <Empty loading={list.loading} error={list.error} count={rows.length} />
      {list.meta?.totalPages > 1 && <Pager meta={list.meta} onPage={list.setPage} />}
      {creating && <PartnerForm scope={scope} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); changed(); }} />}
      {openId && <PartnerDetail id={openId} onClose={() => setOpenId(null)} onChanged={changed} />}
    </>
  );
}

export default function Partners(props) { return <PartnersList scope="content" {...props} />; }
export function Resellers(props) { return <PartnersList scope="reseller" {...props} />; }

// Faixas: uma por linha, "limite:valor" (ex.: 50:200,00). Sem limite: "*:900,00".
const tiersToText = (t = []) => t.map((x) => `${x.upTo ?? "*"}:${(x.amountCents / 100).toFixed(2).replace(".", ",")}`).join("\n");
const textToTiers = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
  const [a, b] = l.split(":");
  return { upTo: a.trim() === "*" ? null : Number(a), amountCents: toCents(b ?? "") };
});

function PartnerForm({ partner, scope, onClose, onSaved }) {
  const run = useAction();
  const edit = !!partner;
  const [f, setF] = useState({
    name: partner?.name || "", slug: partner?.slug || "", contactName: partner?.contactName || "", contactEmail: partner?.contactEmail || "", contactPhone: partner?.contactPhone || "",
    startsAt: dateInput(partner?.startsAt) || dateInput(new Date()), endsAt: dateInput(partner?.endsAt) || dateInput(new Date(Date.now() + 365 * 86400000)),
    billingModel: partner?.billingModel || (scope === "reseller" ? "none" : "fixed"), monthly: partner ? String(partner.monthlyFeeCents / 100) : "", perDevice: partner ? String(partner.perDeviceCents / 100) : "",
    minFee: partner ? String(partner.minFeeCents / 100) : "", tiers: tiersToText(partner?.tiers), deviceLimit: partner?.deviceLimit ?? "",
    dueDay: partner?.dueDay || 10, graceDays: partner?.graceDays ?? 5, suspendPolicy: partner?.suspendPolicy || "auto_after_grace", kind: partner?.kind || SCOPES[scope].defaultKind,
    portalName: "", portalEmail: "", portalPassword: "",
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const { toast } = useUi();
  const submit = async () => {
    const money = { monthlyFeeCents: toCents(f.monthly || 0), perDeviceCents: toCents(f.perDevice || 0), minFeeCents: toCents(f.minFee || 0) };
    const tiers = f.billingModel === "tiered" ? textToTiers(f.tiers) : [];
    if (Object.values(money).includes(null) || tiers.some((t) => t.amountCents === null || Number.isNaN(t.upTo))) {
      return toast("Há um valor inválido em R$ (ou nas faixas). Use números, ex.: 200,00.", "bad");
    }
    const body = {
      name: f.name, contactName: f.contactName || null, contactEmail: f.contactEmail || null, contactPhone: f.contactPhone || null, billingModel: f.billingModel,
      ...money,
      tiers, deviceLimit: f.deviceLimit === "" ? null : Number(f.deviceLimit),
      dueDay: Number(f.dueDay), graceDays: Number(f.graceDays), suspendPolicy: f.suspendPolicy, kind: f.kind,
    };
    if (edit) {
      // Só envia o que mudou: reenviar a data igual a regravaria (fim do dia) sem necessidade.
      if (f.slug !== partner.slug) body.slug = f.slug;
      if (f.startsAt !== dateInput(partner.startsAt)) body.startsAt = spDateToIso(f.startsAt);
      if (f.endsAt !== dateInput(partner.endsAt)) body.endsAt = spDateToIso(f.endsAt, true);
    } else {
      Object.assign(body, { slug: f.slug, startsAt: spDateToIso(f.startsAt), endsAt: spDateToIso(f.endsAt, true) });
      if (f.portalEmail) body.portalUser = { name: f.portalName || f.name, email: f.portalEmail, password: f.portalPassword };
    }
    const r = await run(() => api(edit ? `/admin/partners/${partner.id}` : "/admin/partners", { method: edit ? "PATCH" : "POST", body }), SCOPES[scope].saved);
    if (r) onSaved(r);
  };
  return (
    <Modal title={edit ? `Editar ${SCOPES[scope].noun}` : SCOPES[scope].newLabel} onClose={onClose} wide>
      <div className="row"><Field label="Nome / empresa"><input value={f.name} onChange={set("name")} /></Field><Field label="Identificador (slug)" hint="minúsculas, números e hífens"><input value={f.slug} onChange={set("slug")} /></Field></div>
      <div className="row"><Field label="Contato"><input value={f.contactName} onChange={set("contactName")} /></Field><Field label="E-mail do contato"><input value={f.contactEmail} onChange={set("contactEmail")} /></Field></div>
      <Field label="Telefone do contato"><input value={f.contactPhone} onChange={set("contactPhone")} /></Field>
      <div className="row"><Field label="Início da parceria"><input type="date" value={f.startsAt} onChange={set("startsAt")} /></Field><Field label="Término da parceria"><input type="date" value={f.endsAt} onChange={set("endsAt")} /></Field></div>
      <div className="row">
        <Field label="Modelo de cobrança" hint={f.billingModel === "none" ? "Sem mensalidade: nenhuma cobrança é gerada. Indicado para revendedor que só compra licenças." : undefined}><select value={f.billingModel} onChange={set("billingModel")}>{Object.entries(MODELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Limite de dispositivos" hint="Vazio = ilimitado"><input type="number" min="0" value={f.deviceLimit} onChange={set("deviceLimit")} /></Field>
      </div>
      {f.billingModel === "fixed" && <Field label="Mensalidade (R$)"><input value={f.monthly} onChange={set("monthly")} /></Field>}
      {f.billingModel === "per_device" && <div className="row"><Field label="Valor por dispositivo (R$)"><input value={f.perDevice} onChange={set("perDevice")} /></Field><Field label="Mínimo mensal (R$)"><input value={f.minFee} onChange={set("minFee")} /></Field></div>}
      {f.billingModel === "tiered" && <Field label="Faixas" hint='Uma por linha: "até quantos dispositivos:valor". Última faixa sem limite: "*:valor"'><textarea rows={4} value={f.tiers} onChange={set("tiers")} placeholder={"50:200,00\n200:500,00\n*:900,00"} /></Field>}
      {f.billingModel !== "none" && <div className="row">
        <Field label="Dia de vencimento (1–28)"><input type="number" min="1" max="28" value={f.dueDay} onChange={set("dueDay")} /></Field>
        <Field label="Tolerância (dias)"><input type="number" min="0" value={f.graceDays} onChange={set("graceDays")} /></Field>
      </div>}
      <Field label="Tipo de cadastro" hint="Revenda e 'Parceiro e revenda' têm estoque, clientes e podem editar dispositivos por MAC no portal; tudo fica auditado. Mudar o tipo move o cadastro para a outra tela."><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, ...(!edit && e.target.value === "reseller" && f.billingModel === "fixed" ? { billingModel: "none" } : {}) })}><option value="content">{KIND_LABEL.content}</option><option value="reseller">{KIND_LABEL.reseller}</option><option value="both">{KIND_LABEL.both}</option></select></Field>
      {f.billingModel !== "none" && <Field label="Política de inadimplência"><select value={f.suspendPolicy} onChange={set("suspendPolicy")}><option value="auto_after_grace">Suspender automaticamente após a tolerância</option><option value="manual">Somente manual</option></select></Field>}
      {!edit && <><h3>Acesso ao portal (opcional)</h3><div className="row"><Field label="Nome"><input value={f.portalName} onChange={set("portalName")} /></Field><Field label="E-mail"><input value={f.portalEmail} onChange={set("portalEmail")} /></Field></div><Field label="Senha inicial (mín. 12 caracteres)"><input type="password" value={f.portalPassword} onChange={set("portalPassword")} /></Field></>}
      <div className="actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Salvar</button></div>
    </Modal>
  );
}

function PartnerDetail({ id, onClose, onChanged }) {
  const { confirm, toast } = useUi();
  const run = useAction();
  const [tab, setTab] = useState(null);
  const [devices, setDevices] = useState([]);
  const [webFor, setWebFor] = useState(null); // dispositivo da revenda para o qual se gera um acesso do Player Web
  const [newCode, setNewCode] = useState(false);
  const [editCode, setEditCode] = useState(null);
  const [provForm, setProvForm] = useState(null);
  const [editing, setEditing] = useState(false);
  const role = getAuth()?.user?.role;
  const { data: p, error, reload: load, setData: setP } = useLoad(() => api(`/admin/partners/${id}`), [id]);
  const loadDevices = () => api(`/admin/partners/${id}/devices`, { query: { pageSize: 100 } }).then((r) => setDevices(r.data)).catch(() => {});
  useEffect(() => { loadDevices(); /* eslint-disable-next-line */ }, [id]);
  if (!p) return <Modal title="Parceiro" onClose={onClose}>{error ? <LoadError error={error} onRetry={load} /> : <p className="muted">Carregando…</p>}</Modal>;

  const what = p.kind === "content" ? "parceria" : "revenda";
  const tabList = [
    ...(p.kind !== "content" ? [["stock", "Estoque de licenças"], ["clients", "Clientes"]] : []),
    ["codes", "Códigos"], ["providers", "Servidores IPTV"], ["devices", "Dispositivos"],
    ...(p.billingModel !== "none" || p.invoices.length ? [["invoices", "Mensalidades"]] : []),
    ...(["superadmin", "admin"].includes(role) ? [["users", "Usuários do portal"]] : []),
  ];
  const cur = tab ?? tabList[0][0];
  const act = async (action, o) => {
    const c = await confirm(o);
    if (!c) return;
    const r = await run(() => api(`/admin/partners/${id}/${action}`, { method: "POST", body: { reason: c.reason } }), "Operação concluída.");
    if (r) { setP({ ...p, ...r }); load(); onChanged(); }
  };
  const delProvider = async (pr) => {
    if (!(await confirm({ title: "Excluir servidor", message: `${pr.name} (${pr.baseUrl})`, danger: true }))) return;
    if (await run(() => api(`/admin/partners/${id}/providers/${pr.id}`, { method: "DELETE" }), "Servidor excluído.")) load();
  };
  const revokeCode = async (c) => {
    if (!(await confirm({ title: "Revogar código", message: "Impede novas ativações com este código. Dispositivos já ativados continuam vinculados à parceria.", danger: true }))) return;
    if (await run(() => api(`/admin/partners/${id}/codes/${c.id}/revoke`, { method: "POST" }), "Código revogado.")) load();
  };
  const device = async (a, action, o) => {
    const c = await confirm(o);
    if (!c) return;
    if (await run(() => api(`/admin/devices/activations/${a.id}/${action}`, { method: "POST", body: { reason: c.reason } }), "Dispositivo atualizado.")) { loadDevices(); load(); }
  };
  const generate = async () => {
    const competence = new Date().toISOString().slice(0, 7);
    const r = await run(() => api(`/admin/partners/${id}/invoices`, { method: "POST", body: { competence } }));
    if (r) { toast(r.created ? `Cobrança de ${competence} gerada.` : r.skipped ? "Sem mensalidade a cobrar neste cadastro; nenhuma cobrança foi gerada." : `A cobrança de ${competence} já existia; nada foi criado.`); load(); }
  };

  return (
    <Modal title={p.name} onClose={onClose} wide>
      <dl className="kv">
        <dt>Status</dt><dd><Badge status={p.effectiveStatus} /> {p.statusReason && <span className="muted">— {p.statusReason}</span>}</dd>
        <dt>Contato</dt><dd>{[p.contactName, p.contactEmail, p.contactPhone].filter(Boolean).join(" · ") || "—"}</dd>
        <dt>Identificador</dt><dd>{p.slug}</dd><dt>Vigência</dt><dd>{fmtDate(p.startsAt)} → {fmtDate(p.endsAt)}</dd>
        <dt>Tipo</dt><dd><span className={`kind ${p.kind}`}>{KIND_LABEL[p.kind] || p.kind}</span></dd>
        <dt>Cobrança</dt><dd>{p.billingModel === "none" ? "Sem mensalidade" : `${MODELS[p.billingModel]} · vence dia ${p.dueDay} · tolerância ${p.graceDays} dia(s)`}</dd>
        <dt>Dispositivos</dt><dd>{p.deviceCount}{p.deviceLimit != null ? ` de ${p.deviceLimit}` : " (sem limite)"}</dd>
      </dl>
      <div className="actions left">
        <button className="btn" onClick={() => setEditing(true)}>Editar condições</button>
        {p.status === "active" && <button className="btn" onClick={() => act("suspend", { title: `Suspender ${what}`, message: "Todos os dispositivos vinculados perdem o acesso até a reativação.", reason: "required", danger: true, confirmLabel: "Suspender" })}>Suspender</button>}
        {["active", "suspended"].includes(p.status) && <button className="btn danger" onClick={() => act("block", { title: `Bloquear ${what}`, message: "Todos os dispositivos da parceria perdem o acesso, independentemente do código usado.", reason: "required", danger: true, confirmLabel: "Bloquear" })}>Bloquear</button>}
        {(["suspended", "blocked"].includes(p.status) || (role === "superadmin" && p.status === "cancelled")) && <button className="btn primary" onClick={() => act("reactivate", isPending(p) ? { title: "Aprovar cadastro", message: "O revendedor poderá usar o portal imediatamente.", confirmLabel: "Aprovar" } : { title: `Reativar ${what}`, message: "Os dispositivos elegíveis recuperam o acesso." })}>{isPending(p) ? "Aprovar cadastro" : "Reativar"}</button>}
        {p.status !== "cancelled" && <button className="btn danger" onClick={() => act("cancel", { title: `Cancelar ${what}`, message: "Os dispositivos perdem o acesso. Só o superadmin pode reativar depois.", reason: "required", danger: true })}>Cancelar</button>}
      </div>
      <div className="tabs">{tabList.map(([k, n]) => <button key={k} className={`tab ${cur === k ? "active" : ""}`} onClick={() => setTab(k)}>{n}</button>)}</div>
      {cur === "codes" && <>
        <div className="actions left"><button className="btn primary" onClick={() => setNewCode(true)}>Novo código</button></div>
        <Table><thead><tr><th>Código</th><th>Servidor</th><th>Rótulo</th>{p.kind !== "content" && <th>Licença do estoque</th>}<th>Status</th><th>Ativações (usadas/limite)</th><th>Expira</th><th /></tr></thead><tbody>
          {p.codes.map((c) => <tr key={c.id}><td><strong>{c.code}</strong></td><td>{c.provider ? <>{c.provider.name}{c.provider.status !== "active" && <> <Badge status="disabled" label="Desativado" /></>}<div className="muted">{c.provider.baseUrl}</div></> : c.status === "active" ? <span className="muted" title="Código antigo: o app testa os servidores da parceria por prioridade. Edite para escolher um servidor.">Qualquer servidor ⚠</span> : "—"}</td><td>{c.label || "—"}</td>{p.kind !== "content" && <td>{c.licenseMonths ? <>{c.licenseMonths} {c.licenseMonths === 1 ? "mês" : "meses"} · <span style={c.stockAvailable === 0 ? { color: "var(--bad)" } : undefined}>{c.stockAvailable} em estoque</span></> : <span className="muted" title="Sem licença: este código não consome estoque.">—</span>}</td>}<td><Badge status={c.status === "active" ? "active" : "revoked"} label={c.status === "active" ? "Ativo" : "Revogado"} /></td><td>{c.activationCount ?? 0} / {c.maxActivations ?? "∞"}</td><td>{fmtDate(c.expiresAt)}</td>
            <td className="actions">{c.status === "active" && <button className="btn sm" onClick={() => setEditCode(c)}>Editar</button>}{c.status === "active" && <button className="btn sm danger" onClick={() => revokeCode(c)}>Revogar</button>}</td></tr>)}
        </tbody></Table></>}
      {cur === "providers" && <>
        <p className="muted">Servidores do provedor desta parceria. O cliente digita código, usuário e senha; o servidor monta a URL da playlist e a valida antes de ativar. Cada código aponta para um servidor (veja a coluna “Códigos”): quem usa o código é validado e atendido por ele. Só códigos antigos sem servidor testam todos, do menor para o maior número de prioridade. O modo de entrega vale para todos os dispositivos ligados ao servidor e muda em até alguns segundos.</p>
        <div className="actions left"><button className="btn primary" onClick={() => setProvForm({})}>Adicionar servidor</button></div>
        <Table><thead><tr><th>Nome</th><th>URL base</th><th>Códigos</th><th>Entrega</th><th>Prior.</th><th>Status</th><th /></tr></thead><tbody>
          {p.providers.map((pr) => <tr key={pr.id}><td>{pr.name}</td><td>{pr.baseUrl}</td><td>{p.codes.filter((c) => c.providerId === pr.id && c.status === "active").map((c) => c.code).join(", ") || "—"}</td><td>{pr.deliveryMode === "proxy" ? "Proxy" : "Redirecionamento"}</td><td>{pr.priority}</td><td><Badge status={pr.status} /></td>
            <td className="actions"><button className="btn sm" onClick={() => setProvForm(pr)}>Editar</button><button className="btn sm danger" onClick={() => delProvider(pr)}>Excluir</button></td></tr>)}
        </tbody></Table></>}
      {cur === "stock" && p.kind !== "content" && <StockAdmin partnerId={id} />}
      {cur === "clients" && p.kind !== "content" && <ClientsPanel partnerId={id} />}
      {cur === "users" && <UsersPanel partnerId={id} />}
      {cur === "devices" && <Table><thead><tr><th>MAC</th><th>Servidor</th><th>Entrega</th><th>Status</th><th>Ativado em</th><th /></tr></thead><tbody>
        {devices.map((a) => <tr key={a.id}><td>{a.mac}</td><td>{a.provider?.name || "—"}</td><td><DeliveryBadge mode={a.deliveryMode} fixed={a.deliveryModeFixed} /></td><td><Badge status={accessStatus(a)} /></td><td>{fmtDateTime(a.activatedAt)}</td><td className="actions">
          <RowMenu items={[
            { label: "Gerar acesso Player Web", hidden: !(a.mac && a.status === "active" && p.kind !== "content" && role !== "support"), onClick: () => setWebFor(a) },
            { label: "Bloquear", hidden: a.status !== "active", onClick: () => device(a, "block", { title: "Bloquear dispositivo", message: a.mac, reason: "required", danger: true }) },
            { label: "Desbloquear", hidden: a.status !== "blocked", onClick: () => device(a, "unblock", { title: "Desbloquear", message: a.mac }) },
            { label: "Restaurar", hidden: !(a.status === "revoked" && role === "superadmin"), onClick: () => device(a, "restore", { title: "Restaurar ativação", message: a.mac }) },
            { label: "Remover", danger: true, hidden: a.status === "revoked", onClick: () => device(a, "revoke", { title: "Remover ativação", message: a.mac, danger: true }) },
          ]} />
        </td></tr>)}</tbody></Table>}
      {cur === "invoices" && <>
        <div className="actions left"><button className="btn" onClick={generate}>Gerar cobrança do mês</button></div>
        <Table><thead><tr><th>Competência</th><th>Dispositivos</th><th>Valor</th><th>Pago</th><th>Vencimento</th><th>Status</th></tr></thead><tbody>
          {p.invoices.map((i) => <tr key={i.id}><td>{i.competence}</td><td>{i.deviceCount}</td><td>{fmtMoney(i.amountCents)}</td><td>{fmtMoney(i.paidCents)}</td><td>{fmtDate(i.dueDate)}</td><td><Badge status={i.status} /></td></tr>)}
        </tbody></Table></>}
      {webFor && <NewWebAccess admin initial={{ mac: webFor.mac, partnerId: id }} onClose={() => setWebFor(null)} onDone={load} />}
      {newCode && <CodeModal checkPath="/admin/partners/codes/check" createPath={`/admin/partners/${id}/codes`} balancesPath={`/admin/partners/${id}/stock`} kind={p.kind} providers={p.providers} onClose={() => setNewCode(false)} onCreated={() => { setNewCode(false); load(); }} />}
      {editCode && <CodeEditModal partnerId={id} code={editCode} kind={p.kind} providers={p.providers} onClose={() => setEditCode(null)} onSaved={() => { setEditCode(null); load(); }} />}
      {provForm && <ProviderForm partnerId={id} provider={provForm.id ? provForm : null} onClose={() => setProvForm(null)} onSaved={() => { setProvForm(null); load(); }} />}
      {editing && <PartnerForm partner={p} scope={p.kind === "content" ? "content" : "reseller"} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); onChanged(); }} />}
    </Modal>
  );
}

const DEFAULT_TEMPLATE = "/get.php?username={username}&password={password}&type=m3u_plus&output=m3u8";

function ProviderForm({ partnerId, provider, onClose, onSaved }) {
  const run = useAction();
  const edit = !!provider;
  const [f, setF] = useState({
    name: provider?.name || "", baseUrl: provider?.baseUrl || "", playlistTemplate: provider?.playlistTemplate || DEFAULT_TEMPLATE,
    deliveryMode: provider?.deliveryMode || "redirect", priority: provider?.priority ?? 0, status: provider?.status || "active",
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    const body = { ...f, priority: Number(f.priority) };
    const r = await run(() => api(edit ? `/admin/partners/${partnerId}/providers/${provider.id}` : `/admin/partners/${partnerId}/providers`, { method: edit ? "PATCH" : "POST", body }), "Servidor salvo.");
    if (r) onSaved();
  };
  return (
    <Modal title={edit ? "Editar servidor" : "Novo servidor do provedor"} onClose={onClose}>
      <Field label="Nome"><input value={f.name} onChange={set("name")} placeholder="Servidor principal" /></Field>
      <Field label="URL base" hint="Apenas o endereço, ex.: http://valkiire.net (endereços internos são bloqueados)"><input value={f.baseUrl} onChange={set("baseUrl")} placeholder="http://valkiire.net" /></Field>
      <Field label="Caminho da playlist" hint="Use {username} e {password} (aceita também {usuario} e {senha}). Padrão Xtream: type=m3u_plus&output=m3u8"><textarea rows={2} value={f.playlistTemplate} onChange={set("playlistTemplate")} /></Field>
      <div className="row">
        <Field label="Entrega" hint="Proxy: seu servidor serve o conteúdo e o app nunca vê a URL nem a senha do provedor (consome sua banda). Redirecionamento: o app recebe as credenciais reais e fala direto com o provedor (não usa sua banda)."><select value={f.deliveryMode} onChange={set("deliveryMode")}><option value="redirect">Redirecionamento (302)</option><option value="proxy">Proxy</option></select></Field>
        <Field label="Prioridade" hint="Menor = tentado primeiro"><input type="number" min="0" value={f.priority} onChange={set("priority")} /></Field>
      </div>
      <Field label="Status"><select value={f.status} onChange={set("status")}><option value="active">Ativo</option><option value="disabled">Desativado</option></select></Field>
      <div className="actions"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!f.name || !f.baseUrl} onClick={submit}>Salvar</button></div>
    </Modal>
  );
}
