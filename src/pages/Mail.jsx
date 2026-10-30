import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Badge, Empty, Field, Modal, Pager, Table, fmtDateTime, useAction, useList, useLoad, useUi } from "../ui.jsx";

/**
 * E-mails para revendas e clientes. O envio entra numa fila no servidor (ritmo limitado pelo SMTP configurado no .env);
 * aqui se escreve a mensagem, escolhe o público, confere quantos vão receber e acompanha o andamento.
 */
const AUDIENCES = [
  ["resellers", "Todas as revendas ativas"],
  ["partners", "Todos os parceiros ativos"],
  ["partner", "Uma parceria específica"],
  ["customers", "Clientes com e-mail cadastrado"],
  ["custom", "Lista de e-mails (digitar)"],
];
const DELIVERY = { sent: ["active", "Enviado"], failed: ["blocked", "Falhou"], pending: ["pending", "Na fila"], sending: ["pending", "Enviando"], cancelled: ["cancelled", "Cancelado"] };
const parseEmails = (text) => [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];

export default function Mail() {
  const { confirm } = useUi();
  const run = useAction();
  const status = useLoad(() => api("/admin/mail/status"), []);
  const list = useList("/admin/mail/messages", {});
  const partners = useLoad(() => api("/admin/partners", { query: { pageSize: 100 } }).then((r) => r.data), []);
  const [form, setForm] = useState({ audience: "resellers", partnerId: "", emailsText: "", subject: "", body: "" });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setPreview(null); };

  const s = status.data;
  const { reload: reloadList } = list;
  const reloadStatus = status.reload;
  // Enquanto houver e-mail na fila, o andamento atualiza sozinho.
  useEffect(() => {
    if (!s?.queued) return undefined;
    const t = setInterval(() => { if (!document.hidden) { reloadStatus(); reloadList(); } }, 5000);
    return () => clearInterval(t);
  }, [s?.queued, reloadStatus, reloadList]);

  const audienceBody = () => ({
    audience: form.audience,
    ...(form.audience === "partner" ? { partnerId: form.partnerId } : {}),
    ...(form.audience === "custom" ? { emails: parseEmails(form.emailsText) } : {}),
  });
  const check = async () => {
    const r = await run(() => api("/admin/mail/preview", { method: "POST", body: audienceBody() }));
    if (r) setPreview(r);
    return r;
  };
  const send = async () => {
    const p = preview ?? (await check());
    if (!p) return;
    if (!p.total) return run(() => Promise.reject(new Error("Nenhum destinatário com e-mail válido neste público.")));
    const ok = await confirm({ title: "Enviar e-mail", message: `Enviar "${form.subject.trim()}" para ${p.total} destinatário(s) (${p.label})? Não dá para desfazer o que já saiu.`, confirmLabel: "Enviar" });
    if (!ok) return;
    setBusy(true);
    const r = await run(() => api("/admin/mail/messages", { method: "POST", body: { ...audienceBody(), subject: form.subject, body: form.body } }), "Mensagem na fila de envio.");
    setBusy(false);
    if (r) { setForm((f) => ({ ...f, subject: "", body: "" })); setPreview(null); reloadList(); reloadStatus(); }
  };
  const test = () => run(() => api("/admin/mail/test", { method: "POST" }), "Teste enviado para o seu e-mail de login.");

  const canSend = s?.configured && form.subject.trim().length >= 3 && form.body.trim() && (form.audience !== "partner" || form.partnerId) && (form.audience !== "custom" || form.emailsText.trim());
  return (
    <section>
      {s && (s.configured ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <strong>Servidor de e-mail ativo</strong>
          <div className="muted">{s.host}:{s.port} · remetente {s.from} · {s.ratePerMinute} e-mails/min{s.queued ? ` · ${s.queued} na fila` : ""}</div>
          {s.lastError && <div style={{ color: "var(--bad)", marginTop: 6 }}>Último erro do SMTP: {s.lastError}</div>}
          <div className="actions left" style={{ marginTop: 10 }}><button className="btn sm" onClick={test}>Enviar teste para mim</button></div>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 16 }}>
          <strong style={{ color: "var(--warn)" }}>Servidor de e-mail não configurado</strong>
          <div className="muted">Defina SMTP_HOST, SMTP_USER, SMTP_PASS e MAIL_FROM no .env do backend e reinicie. Veja MAIL.md.</div>
        </div>
      ))}

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>Nova mensagem</h3>
        <Field label="Para">
          <select value={form.audience} onChange={set("audience")}>{AUDIENCES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
        </Field>
        {form.audience === "partner" && (
          <Field label="Parceria">
            <select value={form.partnerId} onChange={set("partnerId")}>
              <option value="">Escolha…</option>
              {(partners.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        {form.audience === "custom" && (
          <Field label="E-mails" hint="Separe por vírgula, espaço ou quebra de linha (até 500).">
            <textarea rows={3} value={form.emailsText} onChange={set("emailsText")} placeholder="cliente@exemplo.com, outro@exemplo.com" />
          </Field>
        )}
        <Field label="Assunto"><input value={form.subject} maxLength={200} onChange={set("subject")} /></Field>
        <Field label="Mensagem" hint="Texto simples. Use {{nome}} para o nome de cada destinatário. Endereços http(s) viram link.">
          <textarea rows={8} value={form.body} maxLength={20000} onChange={set("body")} />
        </Field>
        {preview && (
          <p className="muted">
            {preview.label}: <strong>{preview.total}</strong> destinatário(s){preview.skipped ? ` · ${preview.skipped} endereço(s) inválido(s) ignorado(s)` : ""}
            {preview.sample.length ? ` · ex.: ${preview.sample.map((r) => r.email).join(", ")}` : ""}
          </p>
        )}
        <div className="actions left">
          <button className="btn" onClick={check} disabled={!s?.configured}>Ver destinatários</button>
          <button className="btn primary" onClick={send} disabled={!canSend || busy}>{busy ? "Enviando…" : "Enviar"}</button>
        </div>
      </div>

      <h3>Histórico</h3>
      <Table>
        <thead><tr><th>Data</th><th>Assunto</th><th>Público</th><th>Andamento</th><th /></tr></thead>
        <tbody>{list.data.map((m) => (
          <tr key={m.id}>
            <td>{fmtDateTime(m.createdAt)}<div className="muted" style={{ fontSize: 12 }}>{m.createdByName}</div></td>
            <td>{m.subject}</td>
            <td>{m.audienceLabel}</td>
            <td>
              {m.sent}/{m.total} enviados
              {m.pending > 0 && <div className="muted" style={{ fontSize: 12 }}>{m.pending} na fila</div>}
              {m.failed > 0 && <div style={{ fontSize: 12, color: "var(--bad)" }}>{m.failed} falha(s)</div>}
            </td>
            <td className="actions"><button className="btn sm" onClick={() => setOpen(m.id)}>Detalhes</button></td>
          </tr>
        ))}</tbody>
      </Table>
      <Empty loading={list.loading} error={list.error} count={list.data.length} />
      <Pager meta={list.meta} onPage={list.setPage} />
      {open && <MessageModal id={open} onClose={() => setOpen(null)} onChanged={() => { reloadList(); reloadStatus(); }} />}
    </section>
  );
}

function MessageModal({ id, onClose, onChanged }) {
  const run = useAction();
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const m = useLoad(() => api(`/admin/mail/messages/${id}`, { query: { pageSize: 50, page, ...(filter ? { status: filter } : {}) } }), [id, filter, page]);
  const d = m.data;
  const { reload } = m;
  useEffect(() => {
    if (!d?.pending) return undefined;
    const t = setInterval(() => { if (!document.hidden) reload(); }, 5000);
    return () => clearInterval(t);
  }, [d?.pending, reload]);
  const act = async (path, ok) => { if (await run(() => api(`/admin/mail/messages/${id}/${path}`, { method: "POST" }), ok)) { reload(); onChanged(); } };
  return (
    <Modal title={d?.subject ?? "Mensagem"} onClose={onClose} wide>
      {m.error && <p className="error">{m.error}</p>}
      {d && (
        <>
          <dl className="kv">
            <dt>Público</dt><dd>{d.audienceLabel}</dd>
            <dt>Enviado por</dt><dd>{d.createdByName} · {fmtDateTime(d.createdAt)}</dd>
            <dt>Andamento</dt><dd>{d.sent} enviados · {d.pending} na fila · {d.failed} falhas · {d.cancelled} cancelados (de {d.total})</dd>
          </dl>
          <div className="toolbar">
            <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }} aria-label="Filtrar">
              <option value="">Todos</option><option value="failed">Falhas</option><option value="pending">Na fila</option><option value="sent">Enviados</option><option value="cancelled">Cancelados</option>
            </select>
            {d.failed > 0 && <button className="btn sm" onClick={() => act("retry", "Falhas voltaram para a fila.")}>Reenviar falhas</button>}
            {d.pending > 0 && <button className="btn sm danger" onClick={() => act("cancel", "Envios pendentes cancelados.")}>Cancelar pendentes</button>}
          </div>
          <Table>
            <thead><tr><th>Destinatário</th><th>Status</th><th>Detalhe</th></tr></thead>
            <tbody>{d.deliveries.data.map((r) => {
              const [st, label] = DELIVERY[r.status] ?? [r.status, r.status];
              return (
                <tr key={r.id}>
                  <td>{r.email}{r.name && <div className="muted" style={{ fontSize: 12 }}>{r.name}</div>}</td>
                  <td><Badge status={st} label={label} /></td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.status === "sent" ? fmtDateTime(r.sentAt) : r.error || (r.attempts ? `${r.attempts} tentativa(s)` : "")}</td>
                </tr>
              );
            })}</tbody>
          </Table>
          <Pager meta={d.deliveries.meta} onPage={setPage} />
        </>
      )}
      <div className="actions"><button className="btn" onClick={onClose}>Fechar</button></div>
    </Modal>
  );
}
