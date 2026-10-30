import { useEffect, useState } from "react";
import { Badge, Empty, Pager, Table, fmtDateTime, useDebounced, useList } from "../ui.jsx";

export default function Audit() {
  const list = useList("/admin/audit", { action: "", entityType: "", result: "" });
  const [open, setOpen] = useState(null);
  // A busca por ação espera o usuário parar de digitar (antes disparava uma consulta por tecla).
  const [action, setAction] = useState("");
  const dAction = useDebounced(action);
  useEffect(() => { list.filter({ action: dAction }); /* eslint-disable-next-line */ }, [dAction]);
  return (
    <>
      <div className="page-head"><h2>Auditoria</h2></div>
      <div className="toolbar">
        <input placeholder="Ação (ex.: license, partner.block)" value={action} onChange={(e) => setAction(e.target.value)} />
        <select value={list.params.entityType} onChange={(e) => list.filter({ entityType: e.target.value })}>
          <option value="">Todas as entidades</option>{["license", "partner", "activation", "device", "invoice", "source", "channel", "admin_user"].map((x) => <option key={x}>{x}</option>)}</select>
        <select value={list.params.result} onChange={(e) => list.filter({ result: e.target.value })}><option value="">Qualquer resultado</option><option value="success">Sucesso</option><option value="failure">Falha</option><option value="denied">Negado</option></select>
        <input type="datetime-local" aria-label="De" onChange={(e) => list.filter({ from: e.target.value ? new Date(e.target.value).toISOString() : "" })} />
        <input type="datetime-local" aria-label="Até" onChange={(e) => list.filter({ to: e.target.value ? new Date(e.target.value).toISOString() : "" })} />
      </div>
      <Table><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Entidade</th><th>Resultado</th><th>IP</th></tr></thead>
        <tbody>{list.data.map((e) => (
          <tr key={e.id} className="click" onClick={() => setOpen(open === e.id ? null : e.id)}>
            <td>{fmtDateTime(e.createdAt)}</td><td>{e.actorName || e.actorType}{e.actorId && !e.actorName && <span className="muted"> {String(e.actorId).slice(0, 8)}</span>}</td>
            <td>{e.action}{open === e.id && <pre className="muted" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(e.metadata, null, 2)}</pre>}</td>
            <td>{e.entityType} <span className="muted">{e.entityId && String(e.entityId).slice(0, 8)}</span></td><td><Badge status={e.result} /></td><td>{e.ip}</td></tr>))}</tbody></Table>
      <Empty loading={list.loading} error={list.error} count={list.data.length} />
      <Pager meta={list.meta} onPage={list.setPage} />
    </>
  );
}
