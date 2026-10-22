/**
 * Página aberta pelo QR Code da TV. NÃO configura nada e NÃO tem formulário: só mostra o MAC do aparelho
 * (resolvido pelo servidor a partir do token no fragmento da URL) com um botão para copiar.
 * Quem edita o dispositivo é o revendedor autenticado, no painel, colando o MAC (rastreado em auditoria).
 */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function pairPageHtml({ panelUrl = "" } = {}) {
  const panel = panelUrl
    ? `<p><a id="panel" href="${esc(panelUrl)}" rel="noopener noreferrer" target="_blank">Abrir o painel do revendedor</a></p>`
    : "";
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>MAC da TV – Delta TV</title>
  <style>
    body{font:16px system-ui,sans-serif;max-width:520px;margin:0 auto;padding:1.5rem 1rem;color:#18212f;text-align:center}
    h1{font-size:1.1rem;margin:0 0 1.25rem;color:#536273;font-weight:600}
    .label{font-size:.9rem;color:#536273;margin:0 0 .4rem}
    #mac{display:block;font:700 1.9rem/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.04em;padding:1rem .5rem;border:2px solid #c8d1dc;border-radius:10px;background:#f4f7fb;user-select:all;word-break:break-all}
    #mac[data-state="error"]{font:600 1rem/1.4 system-ui,sans-serif;letter-spacing:0;border-color:#d14343;background:#fdf0f0;user-select:auto;word-break:normal;overflow-wrap:break-word}
    button{margin-top:1rem;width:100%;box-sizing:border-box;font:inherit;font-weight:600;padding:.85rem;cursor:pointer;background:#1463d5;color:#fff;border:0;border-radius:8px}
    button[disabled]{opacity:.45;cursor:not-allowed}
    #status{min-height:1.4rem;margin:.6rem 0 0;color:#1d7a3a;font-weight:600}
    #status[data-error]{color:#b42318}
    .steps{text-align:left;margin:1.5rem 0 0;padding:1rem 1rem 1rem 2rem;background:#edf3fb;border-radius:8px;color:#2b3a4d;font-size:.95rem}
    .steps li{margin:.3rem 0}
    a{color:#1463d5}
  </style>
</head>
<body>
  <h1>Delta TV</h1>
  <p class="label">Endereço MAC desta TV</p>
  <output id="mac" for="copy" data-state="loading" aria-live="polite">Carregando…</output>
  <button id="copy" type="button" disabled>Copiar MAC</button>
  <p id="status" role="status" aria-live="polite"></p>
  <ol class="steps">
    <li>Toque em <b>Copiar MAC</b>.</li>
    <li>Entre no painel do revendedor e abra <b>Dispositivos</b>.</li>
    <li>Cole o MAC, confira o aparelho e configure a lista.</li>
  </ol>
  ${panel}
<script>
(function () {
  var macEl = document.getElementById("mac");
  var btn = document.getElementById("copy");
  var status = document.getElementById("status");
  var mac = "";

  function fail(msg) { macEl.dataset.state = "error"; macEl.textContent = msg; btn.disabled = true; }
  function say(msg, isError) { status.textContent = msg; if (isError) status.setAttribute("data-error", ""); else status.removeAttribute("data-error"); }

  // O token fica no fragmento (não vai ao servidor nem a logs) e é removido da barra de endereço assim que lido.
  var token = (location.hash || "").replace(/^#/, "");
  try { history.replaceState(null, "", location.pathname); } catch (e) {}

  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
    fail("Link inválido. Escaneie novamente o QR Code exibido na TV.");
  } else {
    fetch("/pair/resolve", {
      method: "POST", credentials: "omit", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (r) {
        if (!r.ok || !r.body || !r.body.mac) { fail("QR Code inválido ou expirado. Gere um novo na TV."); return; }
        mac = r.body.mac;
        macEl.dataset.state = "ready";
        macEl.textContent = mac;
        btn.disabled = false;
      })
      .catch(function () { fail("Não foi possível consultar o servidor. Verifique a conexão e tente novamente."); });
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }

  btn.addEventListener("click", function () {
    if (!mac) return;
    var done = function () { say("MAC copiado!"); };
    var manual = function () {
      var range = document.createRange(); range.selectNodeContents(macEl);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      say("Não foi possível copiar automaticamente. O MAC está selecionado: use copiar do seu aparelho.", true);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(mac).then(done, function () { fallbackCopy(mac) ? done() : manual(); });
    } else {
      fallbackCopy(mac) ? done() : manual();
    }
  });
})();
</script>
</body>
</html>`;
}
