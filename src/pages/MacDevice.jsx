import { useState } from "react";
import { api } from "../api.js";
import { Badge, OnlineBadge, Table, fmtDateTime, useAction, useUi } from "../ui.jsx";
import ConfigureForm from "./ConfigureForm.jsx";
import DeviceLists, { livesOf, removeMessage, saveMessage } from "./DeviceLists.jsx";
import { ApplyStock } from "./Stock.jsx";

const ACTION = {
  "device.configuration.confirm": "Lista adicionada/atualizada",
  "device.list.remove": "Lista removida",
  "device.edit.denied": "Tentativa negada",
  "activation.revoke": "Ativação removida",
  "activation.block": "Bloqueada",
  "activation.unblock": "Desbloqueada",
};
const who = (e) => (e.actorName ? `${e.actorName}${e.actorPartnerName ? ` (${e.actorPartnerName})` : ""}` : "—");

/**
 * Edição de um dispositivo POR MAC (revendedores). O backend decide quem pode (token + cadastro ativo) e registra,
 * em auditoria, a pessoa e o revendedor de cada alteração. Este componente só apresenta.
 */
export default function MacDevice() {
  const { confirm } = useUi();
  const run = useAction();
  const [macInput, setMacInput] = useState("");
  const [device, setDevice] = useState(null); // resultado do lookup
  const [history, setHistory] = useState(null);
  const mac = device?.mac;

  const search = async () => {
    setHistory(null);
    const r = await run(() => api("/partner/mac/lookup", { method: "POST", body: { mac: macInput.trim() } }));
    setDevice(r && r !== true ? r : null);
  };
  const reload = async () => {
    const r = await run(() => api("/partner/mac/lookup", { method: "POST", body: { mac } }));
    if (r && r !== true) setDevice(r);
  };
  const submit = async (configuration) => {
    const c = await confirm({
      title: "Adicionar ou atualizar lista",
      message: `${saveMessage(configuration, mac)} Esta alteração será registrada em seu nome.`,
      confirmLabel: configuration.mode === "partner" ? "Salvar parceiro" : "Salvar lista",
    });
    if (!c) return false;
    const ok = await run(() => api("/partner/mac/configure", { method: "POST", body: { mac, configuration } }), "Lista salva.");
    if (ok) { await reload(); setHistory(null); }
    return true;
  };
  // Com várias listas no MAC o servidor exige `activationId`: cada botão Remover aponta para a lista dele.
  const remove = async (list) => {
    const c = await confirm({
      title: "Remover lista", danger: true, reason: "required", confirmLabel: "Remover",
      message: removeMessage(list, mac),
    });
    if (!c) return;
    const r = await run(() => api("/partner/mac/remove-list", { method: "POST", body: { mac, reason: c.reason, activationId: list.activationId } }));
    if (r && r !== true && r.removed === false) await run(async () => { throw new Error(r.message || "Nada a remover."); });
    if (r) { await reload(); setHistory(null); }
  };
  const loadHistory = async () => {
    const r = await run(() => api("/partner/mac/history", { method: "POST", body: { mac } }));
    if (r && r !== true) setHistory(r.events);
  };

  return (
    <section>
      <h3>Dispositivo por MAC</h3>
      <p className="muted">Cole o MAC copiado do QR Code da TV. Toda alteração fica registrada com o seu nome e o do seu revendedor.</p>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <input placeholder="AA:BB:CC:DD:EE:FF" value={macInput} onChange={(e) => setMacInput(e.target.value)} autoComplete="off" spellCheck={false} />
        <button className="btn primary" disabled={macInput.trim().length < 12}>Buscar</button>
      </form>

      {device && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="page-head"><h4 style={{ margin: 0 }}>{mac}</h4><Badge status={livesOf(device).some((l) => l.configured) ? "active" : "pending"} label={`${livesOf(device).length} lista(s)`} /></div>
          <p className="muted">
            <OnlineBadge online={device.online} lastSeenAt={device.lastSeenAt} />{" "}Última atividade: {fmtDateTime(device.lastSeenAt)}
            {device.appVersion ? ` · App ${device.appVersion}` : ""}
          </p>
          <p className="muted">
            Última alteração:{" "}
            {device.lastChange ? <>{who(device.lastChange)} — {ACTION[device.lastChange.action] || device.lastChange.action}, {fmtDateTime(device.lastChange.at)}</> : "nenhuma registrada"}
          </p>

          <DeviceLists device={device} onRemove={remove} />
          <ApplyStock mac={mac} onApplied={() => { reload(); setHistory(null); }} />
          <ConfigureForm key={device.deviceId} device={device} onSubmit={submit} onHistory={loadHistory} />
        </div>
      )}

      {history && (
        <>
          <h4 style={{ marginTop: 16 }}>Histórico deste MAC</h4>
          <Table>
            <thead><tr><th>Quando</th><th>O que</th><th>Quem</th><th>Detalhe</th></tr></thead>
            <tbody>{history.map((e, i) => (
              <tr key={i}><td>{fmtDateTime(e.at)}</td><td>{ACTION[e.action] || e.action}</td><td>{who(e)}</td>
                <td>{[e.details.mode, e.details.listName, e.details.reason].filter(Boolean).join(" · ") || "—"}</td></tr>))}</tbody>
          </Table>
          {history.length === 0 && <p className="muted">Sem registros.</p>}
        </>
      )}
    </section>
  );
}
