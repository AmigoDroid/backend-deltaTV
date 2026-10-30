import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useBalances, monthsLabel } from "./CodeModal.jsx";
import { Badge, Empty, Field, Modal, Pager, RowMenu, Table, fmtDate, fmtDateTime, formatMac, useAction, useDebounced, useList, useUi, PasswordInput } from "../ui.jsx";

/**
 * Acessos ao Player Web. Cada acesso = um código (2 letras + 6 números, ex.: AB123456) que o cliente digita em /player.
 * O acesso tem lista, licença (do estoque) e modo de entrega próprios. `admin` troca a API e mostra o revendedor.
 */
const KINDS = [["live", "TV ao vivo"], ["movie", "Filmes"], ["series", "Séries"], ["api", "Catálogo (listas)"]];
const DEFAULTS = { api: "redirect", live: "proxy", movie: "redirect", series: "redirect" };
const HINT = "Proxy: o servidor entrega o conteúdo (necessário para a TV ao vivo no navegador). Redirect: o servidor só autoriza e manda o player direto ao provedor (não gasta a banda do servidor).";
const fmtCode = (c) => (c ? `${c.slice(0, 2)} ${c.slice(2)}` : "");

function ModesEditor({ value, onChange, readOnly = false }) {
  return (
    <div className="field">
      <span>Modo de entrega por tipo</span>
      {KINDS.map(([k, label]) => (
        <div key={k} style={{ display: "flex", gap: 8, alignItems: "center", margin: "4px 0" }}>
          <span style={{ width: 150 }}>{label}</span>
          <select value={value[k]} disabled={readOnly} onChange={(e) => onChange({ ...value, [k]: e.target.value })}>
            <option value="proxy">Proxy</option><option value="redirect">Redirect</option>
          </select>
        </div>
      ))}
      <small>{HINT}</small>
      {readOnly && <small className="muted">Somente consulta: o modo de entrega é definido pela administração.</small>}
    </div>
  );
}

function ModesModal({ item, base, readOnly, onClose, onSaved }) {
  const run = useAction();
  const [modes, setModes] = useState({ ...DEFAULTS, ...(item.deliveryModes || {}) });
  const save = async (body, msg) => { if (await run(() => api(`${base}/${item.id}`, { method: "PATCH", body }), msg)) onSaved(); };
  return (
    <Modal title={`Entrega · ${fmtCode(item.code)}`} onClose={onClose}>
      <ModesEditor value={modes} onChange={setModes} readOnly={readOnly} />
      <div className="actions">
        {readOnly ? <button className="btn primary" onClick={onClose}>Fechar</button> : (
          <>
            <button className="btn" onClick={() => save({ deliveryModes: null }, "Voltou ao padrão.")}>Restaurar padrão</button>
            <button className="btn primary" onClick={() => save({ deliveryModes: modes }, "Modo de entrega salvo.")}>Salvar</button>
          </>
        )}
      </div>
    </Modal>
  );
}

function CreateModal({ admin, base, initial = {}, onClose, onCreated }) {
  const run = useAction();
  const [partners, setPartners] = useState([]);
  const [partnerId, setPartnerId] = useState(initial.partnerId || "");
  const [useStock, setUseStock] = useState(true);
  const [label, setLabel] = useState(initial.label || "");
  const [source, setSource] = useState("mac"); // mac | partner | playlist
  const [mac, setMac] = useState(initial.mac || "");
  const [lists, setLists] = useState(null);
  const [activationId, setActivationId] = useState("");
  const [f, setF] = useState({ code: "", username: "", password: "", name: "", url: "" });
  const [months, setMonths] = useState("");
  const [modes, setModes] = useState({ ...DEFAULTS });
  const [busy, setBusy] = useState(false);
  const stockPath = admin ? (partnerId && useStock ? `/admin/partners/${partnerId}/stock` : null) : "/partner/stock";
  const balances = useBalances(!!stockPath, stockPath || "");

  useEffect(() => {
    if (admin) api("/admin/partners", { query: { pageSize: 100 } }).then((r) => setPartners(r.data.filter((p) => p.kind !== "content"))).catch(() => {});
  }, [admin]);

  const findLists = async (value = mac) => {
    const r = await run(async () => {
      if (!admin) return (await api("/partner/mac/lookup", { method: "POST", body: { mac: value } })).activations;
      const found = await api("/admin/devices/registrations", { query: { q: value } });
      const norm = formatMac(value);
      const d = found.data?.find((x) => x.mac === norm) ?? found.data?.[0];
      if (!d) throw new Error("MAC não encontrado.");
      return d.activations; // a busca já traz todas as listas vivas do MAC
    });
    if (r) { setLists(r); setActivationId(r.length === 1 ? r[0].activationId : ""); }
  };

  // Aberto a partir de um dispositivo/cliente: o MAC já vem preenchido e as listas dele são buscadas na hora.
  useEffect(() => { if (initial.mac) findLists(initial.mac); /* eslint-disable-next-line */ }, []);

  const needMonths = source === "playlist" || (source === "mac" && lists?.find((l) => l.activationId === activationId)?.mode === "playlist");
  const ready = (source !== "mac" || (mac && activationId)) &&
    (source !== "partner" || (f.code && f.username && f.password)) && (source !== "playlist" || (f.name && f.url)) && (!needMonths || months);

  const submit = async () => {
    const body = { label: label || undefined, months: months ? Number(months) : undefined, ...(admin ? { modes } : {}) };
    if (source === "mac") Object.assign(body, { mac, activationId });
    else if (source === "partner") body.config = { mode: "partner", code: f.code, username: f.username, password: f.password };
    else body.config = { mode: "playlist", name: f.name, url: f.url };
    if (admin) Object.assign(body, { partnerId: partnerId || undefined, useStock: partnerId ? useStock : false });
    setBusy(true);
    const r = await run(() => api(base, { method: "POST", body }), "Acesso web criado.");
    setBusy(false);
    if (r) onCreated(r);
  };

  return (
    <Modal title="Novo acesso web" onClose={onClose} wide>
      {admin && (
        <>
          <Field label="Revendedor (dono do código)"><select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
            <option value="">Sem revendedor (administrador)</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></Field>
          {partnerId && <label className="field"><span><input type="checkbox" checked={useStock} onChange={(e) => setUseStock(e.target.checked)} /> Gastar 1 licença do estoque dele (desmarque para cortesia)</span></label>}
        </>
      )}
      <Field label="Nome do cliente (opcional)"><input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={160} /></Field>
      <Field label="De onde vem a lista">
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="mac">Copiar da TV do cliente (pelo MAC)</option>
          <option value="partner">Servidor do fornecedor (código + usuário + senha)</option>
          <option value="playlist">Link da lista (M3U/Xtream)</option>
        </select>
      </Field>
      {source === "mac" && (
        <>
          <Field label="MAC da TV do cliente" hint={admin ? "Qualquer MAC." : "Só listas e licenças que são suas. Usuário e senha não aparecem: a cópia é feita no servidor."}>
            <div className="input-group"><input value={mac} onChange={(e) => { setMac(formatMac(e.target.value) || e.target.value); setLists(null); setActivationId(""); }} placeholder="00:11:22:33:44:55" />
              <button type="button" className="btn sm" onClick={() => findLists()} disabled={!mac}>Buscar listas</button></div>
          </Field>
          {lists && (lists.length === 0 ? <p className="error">Esta TV não tem lista.</p> : (
            <Field label="Lista"><select value={activationId} onChange={(e) => setActivationId(e.target.value)}>
              <option value="">Selecione…</option>{lists.map((l) => <option key={l.activationId} value={l.activationId}>{l.listName || "Lista"} · {l.mode === "playlist" ? "link próprio" : "servidor"}</option>)}
            </select></Field>))}
        </>
      )}
      {source === "partner" && (
        <>
          <Field label="Código do parceiro" hint="A licença deste acesso é a do código (como numa TV)."><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} maxLength={12} /></Field>
          <Field label="Usuário"><input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" /></Field>
          <Field label="Senha"><PasswordInput value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        </>
      )}
      {source === "playlist" && (
        <>
          <Field label="Nome da lista"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={160} /></Field>
          <Field label="Link da lista"><input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="http://servidor/get.php?username=...&password=..." autoComplete="off" /></Field>
        </>
      )}
      {needMonths && (
        <Field label="Licença do acesso" hint="Tira 1 licença desta duração e o prazo começa agora.">
          <select value={months} onChange={(e) => setMonths(e.target.value)}>
            <option value="">Selecione…</option>
            {(stockPath ? balances.map((b) => b.months) : [1, 3, 6, 12]).map((m) => {
              const b = balances.find((x) => x.months === m);
              return <option key={m} value={m} disabled={stockPath && !b?.quantity}>{monthsLabel(m)}{b ? ` — ${b.quantity} em estoque` : ""}</option>;
            })}
          </select>
          {stockPath && balances.length === 0 && <small className="error">Estoque vazio.</small>}
        </Field>
      )}
      <ModesEditor value={modes} onChange={setModes} readOnly={!admin} />
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={!ready || busy} onClick={submit}>{busy ? "Gerando…" : "Gerar código"}</button>
      </div>
    </Modal>
  );
}

function Created({ item, onClose }) {
  const link = `${location.origin.replace(/:\d+$/, "")}/player`;
  return (
    <Modal title="Acesso web criado" onClose={onClose}>
      <p>Passe este código ao cliente. Ele digita em <b>/player</b> do site do player.</p>
      <pre className="secret" style={{ fontSize: 28, letterSpacing: 2 }}>{item.code}</pre>
      <div className="actions">
        <button className="btn" onClick={() => navigator.clipboard?.writeText(item.code)}>Copiar código</button>
        <button className="btn primary" onClick={onClose}>Concluir</button>
      </div>
      <small className="muted">Endereço do player: {link} (use o endereço do seu site).</small>
    </Modal>
  );
}

/** Gerar acesso web a partir de um dispositivo/cliente (botão no menu da linha). `initial`: { mac, label, partnerId }. */
export function NewWebAccess({ admin = false, initial, onClose, onDone }) {
  const [created, setCreated] = useState(null);
  const base = admin ? "/admin/web-access" : "/partner/web-access";
  if (created) return <Created item={created} onClose={() => { onDone?.(created); onClose(); }} />;
  return <CreateModal admin={admin} base={base} initial={initial} onClose={onClose} onCreated={(r) => { window.dispatchEvent(new Event("stock-changed")); setCreated(r); }} />;
}

const chip = (m) => <Badge status={m} />;

export default function WebAccess({ admin = false }) {
  const base = admin ? "/admin/web-access" : "/partner/web-access";
  const { confirm, toast } = useUi();
  const run = useAction();
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const list = useList(base, { q: "", status: "" });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [modesFor, setModesFor] = useState(null);
  useEffect(() => { list.filter({ q: dq }); /* eslint-disable-next-line */ }, [dq]);

  const act = async (a, action, o, body = {}) => {
    const c = o ? await confirm(o) : {};
    if (c && (await run(() => api(`${base}/${a.id}/${action}`, { method: "POST", body: { ...body, reason: c.reason } }), "Atualizado."))) list.reload();
  };
  const renew = async (a) => {
    const m = window.prompt("Renovar por quantos meses?", "1");
    const months = Number(m);
    if (!m || !Number.isInteger(months) || months < 1) return;
    if (await run(() => api(`${base}/${a.id}/renew`, { method: "POST", body: { months, ...(admin ? { useStock: !!a.partner } : {}) } }), "Renovado.")) list.reload();
  };
  const copy = (c) => navigator.clipboard?.writeText(c).then(() => toast("Código copiado."));

  return (
    <>
      <p className="muted">Cada código libera o Player Web (no navegador) para um cliente, com lista, licença e prazo próprios. Ao vivo passa pelo servidor (proxy); catálogo, filmes e séries vão direto ao provedor (redirect). Você pode mudar isso por acesso (menu ⋮ → Entrega).</p>
      <div className="actions left"><button className="btn primary" onClick={() => setCreating(true)}>Novo acesso web</button></div>
      <div className="section-head">
        <input placeholder="Buscar por nome ou código" aria-label="Buscar" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={list.params.status} onChange={(e) => list.filter({ status: e.target.value })} aria-label="Status">
          <option value="">Todos</option><option value="active">Ativos</option><option value="blocked">Bloqueados</option><option value="revoked">Removidos</option>
        </select>
      </div>
      <Table><thead><tr><th>Código</th><th>Cliente</th>{admin && <th>Revendedor</th>}<th>Lista</th><th>Vence em</th><th>Status</th><th>Último acesso</th><th>Entrega</th><th /></tr></thead><tbody>{list.data.map((a) => {
        const denied = a.status === "active" && a.access && !a.access.allowed;
        const m = a.deliveryModes;
        return (
          <tr key={a.id}>
            <td><strong className="mono">{fmtCode(a.code)}</strong></td>
            <td>{a.label || <span className="muted">—</span>}</td>
            {admin && <td>{a.partner?.name || <span className="muted">Admin</span>}</td>}
            <td>{a.listName || a.provider?.name || <span className="muted">{a.configured ? "—" : "sem lista"}</span>}</td>
            <td>{a.license?.expiresAt ? fmtDate(a.license.expiresAt) : "—"}</td>
            <td>{denied ? <Badge status="expired" label={a.access.message} /> : <Badge status={a.status} />}</td>
            <td>{a.lastLoginAt ? fmtDateTime(a.lastLoginAt) : <span className="muted">nunca</span>}</td>
            <td>{m ? <span title={KINDS.map(([k, l]) => `${l}: ${m[k]}`).join(" · ")}>{chip(m.live)} <span className="muted">ao vivo</span></span> : "—"}</td>
            <td className="actions">
              <RowMenu items={[
                { label: admin ? "Entrega" : "Ver entrega", hidden: a.status === "revoked", onClick: () => setModesFor(a) },
                { label: "Copiar código", hidden: a.status === "revoked", onClick: () => copy(a.code) },
                { label: "Renovar", hidden: a.status === "revoked" || !a.license?.id, onClick: () => renew(a) },
                { label: "Bloquear", hidden: a.status !== "active", onClick: () => act(a, "block", { title: "Bloquear acesso", message: fmtCode(a.code), reason: "required", danger: true }) },
                { label: "Desbloquear", hidden: a.status !== "blocked", onClick: () => act(a, "unblock", { title: "Desbloquear", message: fmtCode(a.code) }) },
                { label: "Remover", danger: true, hidden: a.status === "revoked", onClick: () => act(a, "revoke", { title: "Remover acesso", message: `${fmtCode(a.code)} deixa de funcionar.`, danger: true }) },
              ]} />
            </td>
          </tr>);
      })}</tbody></Table>
      <Empty loading={list.loading} error={list.error} count={list.data.length} /><Pager meta={list.meta} onPage={list.setPage} />
      {creating && <CreateModal admin={admin} base={base} onClose={() => setCreating(false)} onCreated={(r) => { setCreating(false); setCreated(r); list.reload(); window.dispatchEvent(new Event("stock-changed")); }} />}
      {created && <Created item={created} onClose={() => setCreated(null)} />}
      {modesFor && <ModesModal item={modesFor} base={base} readOnly={!admin} onClose={() => setModesFor(null)} onSaved={() => { setModesFor(null); list.reload(); }} />}
    </>
  );
}
