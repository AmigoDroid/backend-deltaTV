import { useEffect, useState } from "react";
import { api, getAuth } from "../api.js";
import { Badge, DeliveryBadge, OnlineBadge, PlatformBadge, accessStatus, Empty, Modal, Pager, RowMenu, Table, fmtDateTime, useAction, useDebounced, useList, useUi } from "../ui.jsx";
import CredentialsModal from "./CredentialsModal.jsx";
import EditDeviceModal from "./EditDeviceModal.jsx";
import DeviceListsModal from "./DeviceListsModal.jsx";
import { NewWebAccess } from "./WebAccess.jsx";

const REFRESH_MS = 20000;

export default function Devices({ onChanged }) {
  const { confirm, toast } = useUi();
  const run = useAction();
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const list = useList("/admin/devices", { q: "", status: "", online: "" });
  const [history, setHistory] = useState(null);
  const [registering, setRegistering] = useState(false);
  const [editing, setEditing] = useState(null); // ativação em edição (só superadmin)
  const [viewing, setViewing] = useState(null); // linha do MAC cujas listas estão abertas (sem precisar da chave da TV)
  const isSuper = getAuth()?.user?.role === "superadmin";
  const canWeb = getAuth()?.user?.role !== "support"; // support só consulta (web:read)
  const [webFor, setWebFor] = useState(null); // linha do MAC para a qual se gera um acesso do Player Web
  const [adding, setAdding] = useState(null); // linha do MAC que vai receber outro parceiro (ou ter o acesso do parceiro atualizado)
  useEffect(() => { list.filter({ q: dq }); /* eslint-disable-next-line */ }, [dq]);

  // Atualização automática da presença: pausa com a aba escondida ou com janela aberta (não atrapalha quem está editando).
  const busy = registering || editing || viewing || adding || history || webFor;
  useEffect(() => {
    if (busy) return undefined;
    const t = setInterval(() => { if (!document.hidden) list.reload(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [busy, list.reload]);

  const change = async (a, action, o) => {
    const c = await confirm(o);
    if (c && (await run(() => api(`/admin/devices/activations/${a.id}/${action}`, { method: "POST", body: { reason: c.reason } }), "Dispositivo atualizado."))) list.reload();
  };
  const openHistory = async (mac) => {
    const r = await run(() => api("/admin/devices/history", { query: { mac } }));
    if (r) setHistory(r);
  };
  const owner = (a) => (a.license ? `Licença ••••${a.license.codeLast4}${a.license.customer ? ` · ${a.license.customer.name}` : ""}` : a.grantedLicense ? `Licença ••••${a.grantedLicense.codeLast4}${a.partner ? ` · Revenda: ${a.partner.name}` : ""}` : a.partner ? `Parceiro: ${a.partner.name}` : "—");

  return (
    <>
      <div className="page-head"><h2>Dispositivos</h2><button className="btn primary" onClick={() => setRegistering(true)}>Cadastrar dispositivo</button></div>
      <div className="toolbar">
        <input placeholder="Pesquisar por MAC" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={list.params.status} onChange={(e) => list.filter({ status: e.target.value })}>
          <option value="">Todos</option><option value="active">Ativos</option><option value="blocked">Bloqueados</option><option value="revoked">Removidos</option>
        </select>
        <select value={list.params.online} onChange={(e) => list.filter({ online: e.target.value })} aria-label="Conexão">
          <option value="">Online e offline</option><option value="true">Só online</option><option value="false">Só offline</option>
        </select>
      </div>
      <Table><thead><tr><th>MAC</th><th>Tipo</th><th>Conexão</th><th>Vínculo atual</th><th>Entrega</th><th>Status</th><th>Ativado em</th><th /></tr></thead>
        <tbody>{list.data.map((a) => (
          <tr key={a.id}><td className="mono">{a.mac || "—"}{a.claimPending && <span className="muted"> (migração pendente)</span>}</td><td><PlatformBadge platform={a.platform} /></td><td><OnlineBadge online={a.online} lastSeenAt={a.lastSeenAt} /></td><td>{owner(a)}</td>
            <td><DeliveryBadge mode={a.deliveryMode} fixed={a.deliveryModeFixed} /></td>
            <td><Badge status={accessStatus(a)} />{a.statusReason && <div className="muted">{a.statusReason}</div>}{a.status === "active" && a.access && !a.access.allowed && <div className="muted">{a.access.message}</div>}</td><td>{fmtDateTime(a.activatedAt)}</td>
            <td className="actions">
              <RowMenu items={[
                { label: "Listas", hidden: !(a.mac && a.deviceId), onClick: () => setViewing(a) },
                { label: "Gerar acesso Player Web", hidden: !(canWeb && a.mac && a.status === "active" && a.platform !== "web"), onClick: () => setWebFor(a) },
                { label: "Editar", hidden: !(isSuper && a.status !== "revoked"), onClick: () => setEditing(a) },
                { label: "Histórico", hidden: !a.mac, onClick: () => openHistory(a.mac) },
                { label: "Adicionar parceiro", hidden: !(a.status !== "revoked" && a.mac), onClick: () => setAdding(a) },
                { label: "Bloquear", hidden: a.status !== "active", onClick: () => change(a, "block", { title: "Bloquear dispositivo", message: `Somente ${a.mac} perde o acesso.`, reason: "required", danger: true }) },
                { label: "Desbloquear", hidden: a.status !== "blocked", onClick: () => change(a, "unblock", { title: "Desbloquear", message: a.mac }) },
                { label: "Restaurar", hidden: !(a.status === "revoked" && isSuper), onClick: () => change(a, "restore", { title: "Restaurar ativação", message: `Desfaz a remoção de ${a.mac}.` }) },
                { label: "Remover", danger: true, hidden: a.status === "revoked", onClick: () => change(a, "revoke", { title: "Remover ativação", message: `Somente este vínculo é removido; as outras listas do MAC ${a.mac} continuam.`, reason: "optional", danger: true }) },
              ]} />
            </td></tr>))}</tbody></Table>
      <Empty loading={list.loading} error={list.error} count={list.data.length} />
      <Pager meta={list.meta} onPage={list.setPage} />
      {webFor && <NewWebAccess admin initial={{ mac: webFor.mac, partnerId: webFor.partner?.id || undefined }} onClose={() => setWebFor(null)} onDone={() => list.reload()} />}
      {registering && (
        <CredentialsModal
          title="Cadastrar dispositivo" askMac submitLabel="Cadastrar"
          intro="Informe o MAC e os dados de acesso. Se o MAC já tiver lista, o parceiro informado é adicionado e as outras listas continuam."
          onSubmit={(body) => api("/admin/devices/register", { method: "POST", body })}
          onClose={() => setRegistering(false)}
          onDone={(r) => { setRegistering(false); toast(`${r.mac} cadastrado${r.listName ? ` na lista “${r.listName}”` : ""}.`); list.reload(); onChanged?.(); }}
        />
      )}
      {adding && (
        <CredentialsModal
          title="Adicionar parceiro ao MAC" mac={adding.mac} submitLabel="Salvar parceiro"
          intro="Um MAC pode ter vários parceiros. Se o código for de um parceiro que ainda não está neste MAC, ele é adicionado e as outras listas continuam. Se já estiver, o acesso dele é atualizado. A alteração fica registrada em seu nome."
          onSubmit={(body) => api(`/admin/devices/registrations/${adding.deviceId}/configuration`, { method: "POST", body: { mode: "partner", confirm: true, ...body } })}
          onClose={() => setAdding(null)}
          onDone={() => { setAdding(null); toast("Parceiro salvo neste MAC."); list.reload(); onChanged?.(); }}
        />
      )}
      {viewing && (
        <DeviceListsModal device={viewing} onClose={() => setViewing(null)} onChanged={() => { list.reload(); onChanged?.(); }} />
      )}
      {editing && (
        <EditDeviceModal device={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); list.reload(); onChanged?.(); }} />
      )}
      {history && (
        <Modal title={`Histórico de ${history.device.mac}`} onClose={() => setHistory(null)} wide>
          <h4>Ativações</h4>
          <Table><thead><tr><th>Vínculo</th><th>Status</th><th>Ativado</th><th>Removido</th></tr></thead><tbody>
            {history.activations.map((a) => <tr key={a.id}><td>{owner(a)}</td><td><Badge status={a.status} /></td><td>{fmtDateTime(a.activatedAt)}</td><td>{fmtDateTime(a.revokedAt)}</td></tr>)}</tbody></Table>
          <h4>Eventos</h4>
          <Table><thead><tr><th>Quando</th><th>Evento</th><th>Quem</th><th>Resultado</th></tr></thead><tbody>
            {history.events.map((e) => <tr key={e.id}><td>{fmtDateTime(e.createdAt)}</td><td>{e.action}</td><td>{e.metadata?.actorName || "—"}</td><td><Badge status={e.result} /></td></tr>)}</tbody></Table>
          {history.events.length === 0 && <p className="muted">Sem eventos registrados.</p>}
        </Modal>
      )}
    </>
  );
}
