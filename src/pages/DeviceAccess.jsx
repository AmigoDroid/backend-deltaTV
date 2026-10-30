import { useEffect, useState } from "react";
import { deviceApi } from "../api.js";
import { Badge, BrandMark, Field, fmtDateTime, useAction, useUi } from "../ui.jsx";
import ConfigureForm from "./ConfigureForm.jsx";
import DeviceLists, { livesOf, removeMessage, saveMessage } from "./DeviceLists.jsx";


/**
 * Login de dispositivo: MAC + chave de 6 dígitos mostrada na TV (Configurações → Acesso por chave).
 * A sessão é limitada a ESSE dispositivo, dura poucos minutos e fica só na memória desta aba.
 */
export default function DeviceAccess({ onBack }) {
  const { confirm } = useUi();
  const run = useAction();
  const [mac, setMac] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState(null); // { token, expiresAt, mac }
  const [device, setDevice] = useState(null);

  const expired = () => { setSession(null); setDevice(null); setKey(""); };
  // Qualquer 401 depois do login = sessão expirada: volta para a tela de entrada.
  const call = async (path, opts) => {
    try { return await deviceApi(path, { token: session.token, ...opts }); }
    catch (e) { if (e.status === 401) expired(); throw e; }
  };
  const load = async () => { const d = await run(() => call("/me")); if (d && d !== true) setDevice(d); };
  useEffect(() => { if (session) load(); }, [session?.token]);

  const login = async (e) => {
    e.preventDefault();
    setBusy(true);
    const r = await run(() => deviceApi("/login", { method: "POST", body: { mac: mac.trim(), key } }));
    setBusy(false);
    setKey(""); // a chave é de uso único: não fica na tela
    if (r && r !== true) setSession(r);
  };
  const logout = async () => { await run(() => call("/logout", { method: "POST" })).catch(() => {}); expired(); };

  const submit = async (configuration) => {
    const c = await confirm({
      title: "Adicionar ou atualizar lista", confirmLabel: configuration.mode === "partner" ? "Salvar parceiro" : "Salvar lista",
      message: saveMessage(configuration, session.mac),
    });
    if (!c) return false;
    if (await run(() => call("/configure", { method: "POST", body: configuration }), "Lista salva.")) await load();
    return true;
  };
  // Com várias listas no MAC o servidor exige `activationId`: cada botão Remover aponta para a lista dele.
  const remove = async (list) => {
    const c = await confirm({ title: "Remover lista", danger: true, reason: "required", confirmLabel: "Remover", message: removeMessage(list, session.mac) });
    if (!c) return;
    const r = await run(() => call("/remove-list", { method: "POST", body: { reason: c.reason, activationId: list.activationId } }));
    if (r && r !== true && r.removed === false) await run(async () => { throw new Error(r.message || "Nada a remover."); });
    if (r) await load();
  };

  if (!session) {
    return (
      <div className="auth"><div className="login card">
        <div className="auth-brand"><BrandMark size={44} /><div><strong>DeltaTV</strong><span>Acesso por chave da TV</span></div></div>
        <h2 style={{ marginBottom: 8 }}>Login de dispositivo</h2>
        <p className="muted" style={{ marginBottom: 16 }}>Na TV: Configurações → Acesso por chave → OK. Informe o MAC e a chave de 6 dígitos exibidos.</p>
        <form onSubmit={login}>
          <Field label="MAC da TV"><input placeholder="AA:BB:CC:DD:EE:FF" value={mac} onChange={(e) => setMac(e.target.value)} autoComplete="off" spellCheck={false} required /></Field>
          <Field label="Chave de 6 dígitos"><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="000000" value={key} onChange={(e) => setKey(e.target.value.replace(/\D/g, ""))} autoComplete="off" required /></Field>
          <button className="btn primary" style={{ width: "100%" }} disabled={busy || key.length !== 6 || mac.trim().length < 11}>{busy ? "Entrando…" : "Entrar"}</button>
        </form>
        {onBack && <p style={{ marginTop: 16, textAlign: "center" }}><button className="btn sm" onClick={onBack}>Voltar ao login do painel</button></p>}
      </div></div>
    );
  }

  return (
    <div className="auth"><div className="login card" style={{ maxWidth: 640, width: "100%" }}>
      <div className="page-head">
        <h3 style={{ margin: 0 }}>{session.mac}</h3>
        {device && <Badge status={livesOf(device).some((l) => l.configured) ? "active" : "pending"} label={`${livesOf(device).length} lista(s)`} />}
      </div>
      <p className="muted">Acesso limitado a este dispositivo · expira às {fmtDateTime(session.expiresAt)}</p>
      {device && <DeviceLists device={device} onRemove={remove} />}
      {device && <ConfigureForm device={device} onSubmit={submit} />}
      <p style={{ marginTop: 16 }}><button className="btn sm" onClick={logout}>Sair</button></p>
    </div></div>
  );
}
