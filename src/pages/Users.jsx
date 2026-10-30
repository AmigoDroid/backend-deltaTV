import { useEffect, useState } from "react";
import { api, getAuth } from "../api.js";
import { Badge, Empty, Field, Modal, PasswordInput, Pager, Table, fmtDateTime, useAction, useDebounced, useList } from "../ui.jsx";

/**
 * Usuários da plataforma. superadmin gerencia todos; admin gerencia só os usuários do portal de revendas/parceiros
 * (o backend impõe essa regra; aqui o formulário apenas não oferece o que seria recusado).
 * `partnerId` fixo = aba dentro do detalhe de uma revenda.
 */
const ROLE = { superadmin: "Superadmin", admin: "Admin", support: "Suporte", partner: "Portal do parceiro" };

export function UsersPanel({ partnerId: fixedPartnerId }) {
  const me = getAuth()?.user;
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const list = useList("/admin/users", { q: "", role: "", status: "", partnerId: fixedPartnerId || "" });
  const [form, setForm] = useState(null);
  const [partners, setPartners] = useState([]);
  useEffect(() => { list.filter({ q: dq }); /* eslint-disable-next-line */ }, [dq]);
  useEffect(() => {
    if (fixedPartnerId) return;
    api("/admin/partners", { query: { pageSize: 100 } }).then((r) => setPartners(r.data)).catch(() => {});
  }, [fixedPartnerId]);
  const full = me?.role === "superadmin";

  return (
    <>
      <div className="toolbar">
        <input placeholder="Buscar por nome ou e-mail" value={q} onChange={(e) => setQ(e.target.value)} />
        {full && !fixedPartnerId && <select value={list.params.role} onChange={(e) => list.filter({ role: e.target.value })}><option value="">Todas as funções</option>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
        <select value={list.params.status} onChange={(e) => list.filter({ status: e.target.value })}><option value="">Todos os status</option><option value="active">Ativos</option><option value="disabled">Desativados</option></select>
        <button className="btn primary" onClick={() => setForm({})}>Novo usuário</button>
      </div>
      <Table>
        <thead><tr><th>Nome</th><th>E-mail</th><th>Função</th>{!fixedPartnerId && <th>Revenda / parceiro</th>}<th>Status</th><th>Criado em</th><th /></tr></thead>
        <tbody>{list.data.map((u) => (
          <tr key={u.id}>
            <td>{u.name}{u.id === me?.id && <span className="muted"> (você)</span>}</td><td>{u.email}</td><td>{ROLE[u.role] || u.role}</td>
            {!fixedPartnerId && <td>{u.partnerName || "—"}</td>}
            <td><Badge status={u.status === "active" ? "active" : "disabled"} label={u.status === "active" ? "Ativo" : "Desativado"} /></td>
            <td>{fmtDateTime(u.createdAt)}</td>
            <td className="actions"><button className="btn sm" onClick={() => setForm({ user: u })}>Editar</button></td>
          </tr>))}</tbody>
      </Table>
      <Empty loading={list.loading} error={list.error} count={list.data.length} />
      <Pager meta={list.meta} onPage={list.setPage} />
      {form && <UserForm {...form} me={me} full={full} fixedPartnerId={fixedPartnerId} partners={partners} onClose={() => setForm(null)} onSaved={() => { setForm(null); list.reload(); }} />}
    </>
  );
}

function UserForm({ user, me, full, fixedPartnerId, partners, onClose, onSaved }) {
  const run = useAction();
  const edit = !!user;
  const self = user?.id === me?.id;
  const [f, setF] = useState({
    name: user?.name || "", email: user?.email || "", role: user?.role || (full && !fixedPartnerId ? "admin" : "partner"),
    partnerId: user?.partnerId || fixedPartnerId || "", status: user?.status || "active", password: "",
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const isPartner = f.role === "partner";
  const roleLocked = !full || !!fixedPartnerId || self;
  const submit = async () => {
    const body = { name: f.name, email: f.email, role: f.role, partnerId: isPartner ? f.partnerId : null, status: f.status };
    if (f.password) body.password = f.password;
    if (!edit) { body.password = f.password; if (!isPartner) delete body.partnerId; if (isPartner && !body.partnerId) return; delete body.status; }
    const r = await run(() => api(edit ? `/admin/users/${user.id}` : "/admin/users", { method: edit ? "PATCH" : "POST", body }), "Usuário salvo.");
    if (r) onSaved();
  };
  return (
    <Modal title={edit ? "Editar usuário" : "Novo usuário"} onClose={onClose}>
      <div className="row"><Field label="Nome"><input value={f.name} onChange={set("name")} /></Field><Field label="E-mail"><input type="email" value={f.email} onChange={set("email")} /></Field></div>
      <div className="row">
        <Field label="Função" hint={self ? "Você não pode alterar a própria função." : undefined}>
          <select value={f.role} onChange={set("role")} disabled={roleLocked}>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        {isPartner && !fixedPartnerId && (
          <Field label="Revenda / parceiro"><select value={f.partnerId} onChange={set("partnerId")}><option value="">Selecione…</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        )}
      </div>
      {edit && <Field label="Status" hint={self ? "Você não pode desativar a própria conta." : "Desativar encerra as sessões abertas do usuário."}><select value={f.status} onChange={set("status")} disabled={self}><option value="active">Ativo</option><option value="disabled">Desativado</option></select></Field>}
      <Field label={edit ? "Nova senha (deixe vazio para manter)" : "Senha inicial (mín. 12 caracteres)"} hint={edit ? "Ao trocar senha, função, revenda ou e-mail, as sessões abertas do usuário são encerradas." : undefined}>
        <PasswordInput value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      </Field>
      <div className="actions"><button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={!f.name || !f.email || (!edit && f.password.length < 12) || (isPartner && !f.partnerId)} onClick={submit}>Salvar</button></div>
    </Modal>
  );
}

export default function Users() {
  return (
    <>
      <div className="page-head"><h2>Usuários</h2></div>
      <UsersPanel />
    </>
  );
}
