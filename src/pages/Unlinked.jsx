import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Empty, OnlineBadge, Pager, PlatformBadge, RowMenu, Table, fmtDateTime, useAction, useDebounced, useList, useUi } from "../ui.jsx";
import CredentialsModal from "./CredentialsModal.jsx";

const REFRESH_MS = 15000;

/**
 * Dispositivos que abriram o app, foram registrados pelo servidor e ainda não têm lista (ou tiveram a lista removida).
 * O administrador clica em "Vincular" e informa código, usuário e senha; o backend valida no provedor e ativa.
 */
export default function Unlinked({ onChanged }) {
  const { confirm, toast } = useUi();
  const run = useAction();
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const list = useList("/admin/devices/unlinked", { q: "" });
  const [linking, setLinking] = useState(null);   // dispositivo escolhido
  const [registering, setRegistering] = useState(false);
  const [auto, setAuto] = useState(true);
  useEffect(() => { list.filter({ q: dq }); /* eslint-disable-next-line */ }, [dq]);

  // Atualização automática: o aparelho que acabou de abrir o app aparece sem recarregar a página.
  // Pausa enquanto há janela aberta (não atrapalha quem está digitando) e com a aba escondida.
  useEffect(() => {
    if (!auto || linking || registering) return undefined;
    const t = setInterval(() => { if (!document.hidden) list.reload(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [auto, linking, registering, list.reload]);

  const refreshAll = () => { list.reload(); onChanged?.(); };

  const remove = async (d) => {
    const c = await confirm({
      title: "Excluir dispositivo", danger: true, confirmLabel: "Excluir",
      message: `${d.mac} será removido da lista. Se o aplicativo for aberto novamente nessa TV, ele volta a aparecer aqui.`,
    });
    if (c && (await run(() => api(`/admin/devices/unlinked/${d.id}`, { method: "DELETE" }), "Dispositivo excluído."))) refreshAll();
  };

  return (
    <>
      <div className="page-head">
        <h2>Dispositivos sem vínculo</h2>
        <button className="btn primary" onClick={() => setRegistering(true)}>Cadastrar dispositivo</button>
      </div>
      <p className="muted">
        Aparelhos que abriram o aplicativo mas ainda não têm lista. Clique em <strong>Vincular</strong> e informe o código, o usuário e a senha — o acesso é
        validado no provedor e a TV recebe a lista sozinha.
      </p>
      <div className="toolbar">
        <input placeholder="Pesquisar por MAC" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={list.reload}>Atualizar</button>
        <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Atualizar automaticamente</label>
      </div>
      <Table>
        <thead><tr><th>MAC</th><th>Tipo</th><th>Situação</th><th>Última atividade</th><th>Primeiro registro</th><th /></tr></thead>
        <tbody>
          {list.data.map((d) => (
            <tr key={d.id} className="click" onClick={() => setLinking(d)}>
              <td className="mono">{d.mac}</td>
              <td><PlatformBadge platform={d.platform} /></td>
              <td className="wrap">
                {d.previouslyLinked
                  ? <><span className="badge warn">Desvinculado</span><div className="muted">{d.lastUnlinkReason || "Lista removida"} · {fmtDateTime(d.lastUnlinkedAt)}</div></>
                  : <span className="badge info">Novo</span>}
                {d.waiting && <div><span className="dot" /> <span className="muted">TV aguardando agora</span></div>}
              </td>
              <td><OnlineBadge online={d.online} lastSeenAt={d.lastSeenAt} /><div className="muted">{fmtDateTime(d.lastSeenAt)}</div></td>
              <td>{fmtDateTime(d.firstSeenAt)}</td>
              <td className="actions" onClick={(e) => e.stopPropagation()}>
                <RowMenu items={[
                  { label: "Vincular", onClick: () => setLinking(d) },
                  { label: "Excluir", danger: true, hidden: !!d.previouslyLinked, onClick: () => remove(d) },
                ]} />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Empty loading={list.loading && !list.data.length} error={list.error} count={list.data.length} />
      {!list.loading && !list.error && !list.data.length && !dq && <p className="muted">Nenhum dispositivo aguardando vínculo. Quando uma TV abrir o aplicativo pela primeira vez, ela aparece aqui.</p>}
      <Pager meta={list.meta} onPage={list.setPage} />

      {linking && (
        <CredentialsModal
          title="Vincular dispositivo" mac={linking.mac} submitLabel="Vincular"
          intro="Informe os dados de acesso do cliente. Eles são conferidos no provedor antes de ativar."
          onSubmit={(body) => api(`/admin/devices/unlinked/${linking.id}/link`, { method: "POST", body })}
          onClose={() => setLinking(null)}
          onDone={(r) => { setLinking(null); toast(`${linking.mac} vinculado${r.listName ? ` à lista “${r.listName}”` : ""}.`); refreshAll(); }}
        />
      )}
      {registering && (
        <CredentialsModal
          title="Cadastrar dispositivo" askMac submitLabel="Cadastrar"
          intro="Cadastre um aparelho que ainda não abriu o aplicativo. Quando a TV abrir, ela já entra com a lista."
          onSubmit={(body) => api("/admin/devices/register", { method: "POST", body })}
          onClose={() => setRegistering(false)}
          onDone={(r) => { setRegistering(false); toast(`${r.mac} cadastrado${r.listName ? ` na lista “${r.listName}”` : ""}.`); refreshAll(); }}
        />
      )}
    </>
  );
}
