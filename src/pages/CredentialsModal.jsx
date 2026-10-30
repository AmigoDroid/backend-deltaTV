import { useEffect, useRef, useState } from "react";
import { Field, Modal, PasswordInput, formatMac, useAction } from "../ui.jsx";

/**
 * Janela única para ligar um dispositivo a uma lista de parceria: código + usuário + senha do provedor.
 *  - askMac: pede também o MAC (cadastro de um aparelho novo). Sem isso, o MAC vem de `mac` e é só exibido.
 *  - onSubmit(body) faz a chamada à API e devolve o resultado (ou lança). A senha nunca fica depois do envio.
 * O backend valida o código e o login no provedor antes de ativar; erros voltam como toast e a janela continua aberta.
 */
export default function CredentialsModal({ title, mac, askMac = false, submitLabel = "Vincular", intro, onSubmit, onClose, onDone }) {
  const run = useAction();
  const [f, setF] = useState({ mac: "", code: "", username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const normalizedMac = askMac ? formatMac(f.mac) : mac;
  const macError = askMac && f.mac.trim() && !normalizedMac ? "O MAC precisa ter 12 dígitos hexadecimais (0–9, A–F)." : "";
  const valid = !!normalizedMac && /^[A-Za-z0-9]{4,12}$/.test(f.code.trim()) && f.username.trim() && f.password;

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const body = { code: f.code.trim(), username: f.username.trim(), password: f.password, ...(askMac ? { mac: normalizedMac } : {}) };
    const r = await run(() => onSubmit(body));
    setBusy(false);
    setF((x) => ({ ...x, password: "" })); // nunca deixa a senha do provedor no estado depois do envio
    if (r) onDone(r);
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        {intro && <p className="muted">{intro}</p>}
        {askMac ? (
          <Field label="MAC do aparelho" hint={macError || "Aceita com ou sem “:” — ex.: AA:BB:CC:DD:EE:FF"}>
            <input ref={first} className="mono" value={f.mac} onChange={set("mac")} placeholder="AA:BB:CC:DD:EE:FF" autoComplete="off" spellCheck={false} aria-invalid={!!macError} />
          </Field>
        ) : (
          <Field label="MAC do aparelho"><input className="mono" value={mac} readOnly tabIndex={-1} /></Field>
        )}
        <Field label="Código" hint="Código da parceria (4 a 12 letras ou números)">
          <input ref={askMac ? undefined : first} className="mono" value={f.code} onChange={set("code")} maxLength={12} autoComplete="off" spellCheck={false} />
        </Field>
        <div className="row">
          <Field label="Usuário"><input value={f.username} onChange={set("username")} maxLength={128} autoComplete="off" spellCheck={false} /></Field>
          <Field label="Senha"><PasswordInput value={f.password} onChange={set("password")} maxLength={128} /></Field>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={!valid || busy}>{busy ? "Validando no provedor…" : submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
