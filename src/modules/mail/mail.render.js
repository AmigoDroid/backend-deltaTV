/**
 * Monta o e-mail (texto + HTML) a partir do que o administrador escreveu. Funções puras, sem rede nem banco.
 * O texto do administrador NUNCA vira HTML cru: tudo é escapado e só URLs http(s) viram link. Assunto e nome perdem
 * quebras de linha (evita injeção de cabeçalho). Variáveis aceitas: {{nome}} e {{email}}.
 */
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
export const oneLine = (s, max) => String(s ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function fillVars(template, vars) {
  return String(template).replace(/\{\{\s*(nome|email)\s*\}\}/gi, (_, k) => vars[k.toLowerCase()] ?? "");
}

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[.,;:!?)\]]+$/;
function inlineHtml(line) {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(URL_RE)) {
    const trail = m[0].match(TRAILING)?.[0] ?? "";
    const url = trail ? m[0].slice(0, -trail.length) : m[0];
    let valid = true;
    try { new URL(url); } catch { valid = false; }
    out += esc(line.slice(last, m.index));
    out += valid ? `<a href="${esc(url)}" style="color:#2563eb">${esc(url)}</a>` : esc(url);
    out += esc(trail);
    last = m.index + m[0].length;
  }
  return out + esc(line.slice(last));
}

export function renderMail({ subject, body, name, email }, { footer = "" } = {}) {
  const vars = { nome: oneLine(name, 160) || "cliente", email: oneLine(email, 200) };
  const subj = oneLine(fillVars(subject, vars), 200);
  const text = fillVars(body, vars).replace(/\r\n?/g, "\n").trim();
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.split("\n").map(inlineHtml).join("<br>")}</p>`)
    .join("");
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937">`
    + `<div style="max-width:600px;margin:0 auto;padding:24px"><div style="background:#ffffff;border-radius:10px;padding:28px;font-size:15px;line-height:1.55">${paragraphs}</div>`
    + (footer ? `<p style="font-size:12px;color:#6b7280;margin:14px 4px 0">${esc(footer)}</p>` : "")
    + `</div></body></html>`;
  return { subject: subj, text: footer ? `${text}\n\n--\n${footer}` : text, html };
}
