import { useState } from "react";
import { Field } from "../ui.jsx";
import { hasLicenseList } from "./DeviceLists.jsx";

/** Corpo de configuração aceito pelo backend (parceria ou lista própria). */
export const buildConfiguration = (mode, f) =>
  mode === "partner"
    ? { mode, confirm: true, code: f.code, username: f.username, password: f.password }
    : { mode, confirm: true, name: f.name, url: f.url, ...(f.licenseCode ? { licenseCode: f.licenseCode } : {}) };

/**
 * Formulário "adicionar/atualizar lista" compartilhado pelo painel do revendedor (por MAC) e pelo login de dispositivo (por chave).
 * Um MAC pode ter VÁRIOS parceiros: informar um parceiro novo o ADICIONA; informar um que já está no MAC atualiza o acesso dele.
 * onSubmit(body) devolve true se a operação foi tentada (a senha é limpa), false se o usuário desistiu na confirmação.
 */
export default function ConfigureForm({ device, onSubmit, onHistory }) {
  const [mode, setMode] = useState("partner");
  const [f, setF] = useState({ code: "", username: "", password: "", licenseCode: "", name: "", url: "" });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  // A lista própria vive na ativação por licença do MAC; sem ela, o servidor exige o código da licença.
  const needsLicense = !hasLicenseList(device);
  const submit = async (e) => {
    e.preventDefault();
    const attempted = await onSubmit(buildConfiguration(mode, f));
    if (attempted) setF((x) => ({ ...x, password: "" })); // nunca deixa a senha do provedor na tela/estado
  };
  return (
    <form onSubmit={submit}>
      <h4 style={{ marginTop: 16 }}>Adicionar ou atualizar lista</h4>
      <Field label="Tipo de lista">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="partner">Parceria (código + usuário e senha do provedor)</option>
          <option value="playlist">Lista própria (nome + URL M3U)</option>
        </select>
      </Field>
      {mode === "partner" ? (
        <>
          <p className="muted">Parceiro novo neste MAC = é adicionado, sem mexer nas outras listas. Parceiro que já está no MAC = o acesso dele é atualizado.</p>
          <Field label="Código"><input value={f.code} onChange={set("code")} required minLength={4} maxLength={12} autoComplete="off" /></Field>
          <Field label="Usuário do provedor"><input value={f.username} onChange={set("username")} required autoComplete="off" /></Field>
          <Field label="Senha do provedor"><input type="password" value={f.password} onChange={set("password")} required autoComplete="new-password" /></Field>
        </>
      ) : (
        <>
          <Field label="Nome da lista"><input value={f.name} onChange={set("name")} required maxLength={160} /></Field>
          <Field label="URL da lista (M3U)"><input value={f.url} onChange={set("url")} required type="url" autoComplete="off" /></Field>
          {needsLicense && <Field label="Código da licença" hint="Obrigatório para ativar uma TV que ainda não tem licença."><input value={f.licenseCode} onChange={set("licenseCode")} minLength={8} autoComplete="off" /></Field>}
        </>
      )}
      <div className="actions left">
        <button className="btn primary">{mode === "partner" ? "Adicionar / atualizar parceiro" : "Salvar lista própria"}</button>
        {onHistory && <button type="button" className="btn" onClick={onHistory}>Ver histórico</button>}
      </div>
    </form>
  );
}
