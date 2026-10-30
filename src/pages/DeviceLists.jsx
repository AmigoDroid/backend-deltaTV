import { Badge, Table, fmtDateTime } from "../ui.jsx";

// Estados de UMA lista (ativação) do dispositivo, como o servidor devolve em `activations[].status`.
export const STATE = {
  configured_partner: "Parceria configurada",
  configured_playlist: "Lista própria configurada",
  awaiting_configuration: "Aguardando configuração",
  session_required: "Ativado (aguardando a TV reconectar)",
  deactivated: "Desativado (sem lista)",
  disabled: "Bloqueado",
  expired: "Expirado",
  error: "Serviço do provedor indisponível",
};
export const KIND = { partner: "Parceria", license: "Lista própria" };

const tone = (l) => {
  if (l.configured && l.allowed) return "active";
  if (l.status === "expired") return "expired";
  if (l.status === "disabled" || l.status === "error") return "blocked";
  return "pending";
};

/** Listas vivas do dispositivo: um MAC pode ter várias (no máximo uma por parceiro + uma lista própria). */
export const livesOf = (device) => device?.activations ?? [];

/** Há ativação por licença (lista própria) neste MAC? Sem ela, a lista própria precisa do código da licença. */
export const hasLicenseList = (device) => livesOf(device).some((l) => l.kind === "license");

export default function DeviceLists({ device, onRemove }) {
  const lists = livesOf(device);
  if (!lists.length) return <p className="muted">Nenhuma lista vinculada a este MAC.</p>;
  return (
    <>
      <h4 style={{ marginTop: 12 }}>Listas deste MAC ({lists.length})</h4>
      <Table>
        <thead><tr><th>Tipo</th><th>Lista</th><th>Situação</th><th>Expira em</th><th /></tr></thead>
        <tbody>
          {lists.map((l) => (
            <tr key={l.activationId}>
              <td>{KIND[l.kind] || l.kind}</td>
              <td>{l.listName || "—"}</td>
              <td className="wrap">
                <Badge status={tone(l)} label={STATE[l.status] || l.status} />
                {!l.allowed && l.message && <div className="muted">{l.message}</div>}
              </td>
              <td>{l.expiresAt ? fmtDateTime(l.expiresAt) : "—"}</td>
              <td className="actions">{onRemove && <button className="btn sm danger" onClick={() => onRemove(l)}>Remover</button>}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

/** Texto de confirmação ao remover UMA lista: deixa claro que as outras do MAC continuam. */
export const removeMessage = (l, mac) => (l.kind === "partner"
  ? `Será removido somente o vínculo desta TV com “${l.listName || "o parceiro"}”. As listas dos outros parceiros deste MAC continuam. MAC: ${mac}`
  : `A lista própria será apagada desta TV; a licença e as listas dos parceiros continuam. MAC: ${mac}`);

/** Texto de confirmação ao adicionar/atualizar uma lista, conforme o tipo. */
export const saveMessage = (configuration, mac) => (configuration.mode === "partner"
  ? `Se este parceiro (código) ainda não estiver neste MAC, ele será ADICIONADO e as listas dos outros parceiros continuam. Se já estiver, o acesso dele é atualizado. MAC: ${mac}`
  : `A lista própria deste MAC será criada ou substituída; as listas dos parceiros continuam. MAC: ${mac}`);
