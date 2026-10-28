import test from "node:test";
import assert from "node:assert/strict";
import { renderMail, fillVars, oneLine } from "../../src/modules/mail/mail.render.js";
import { isPermanent, backoffMinutes } from "../../src/modules/mail/mail.worker.js";
import { isEmail } from "../../src/modules/mail/mail.recipients.js";

test("variáveis {{nome}} e {{email}}, com fallback para o nome", () => {
  const m = renderMail({ subject: "Oi {{ nome }}", body: "{{nome}} <{{email}}>", name: "Ana", email: "a@x.com" });
  assert.equal(m.subject, "Oi Ana");
  assert.equal(renderMail({ subject: "Oi {{nome}}", body: "x", name: "", email: "a@x.com" }).subject, "Oi cliente");
  assert.equal(fillVars("{{NOME}}", { nome: "Z" }), "Z");
});

test("o texto do administrador nunca vira HTML cru e só http(s) vira link", () => {
  const { html, text } = renderMail({ subject: "s", body: 'a <img src=x onerror=1> "q"\nver https://a.com/p?x=1&y=2. e javascript:alert(1)', name: "N", email: "a@x.com" });
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes('href="https://a.com/p?x=1&amp;y=2"'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(text.includes("https://a.com/p?x=1&y=2."));
});

test("assunto e nome perdem quebras de linha (sem injeção de cabeçalho)", () => {
  assert.equal(oneLine("a\r\nBcc: x@y.com", 200), "a Bcc: x@y.com");
  assert.ok(!renderMail({ subject: "a\nBcc: x", body: "b", name: "n\r\nm", email: "a@x.com" }).subject.includes("\n"));
});

test("rodapé entra no texto e no HTML", () => {
  const m = renderMail({ subject: "s", body: "b", name: "n", email: "a@x.com" }, { footer: "Rodapé & cia" });
  assert.ok(m.text.endsWith("--\nRodapé & cia"));
  assert.ok(m.html.includes("Rodapé &amp; cia"));
});

test("classificação de erro do SMTP", () => {
  assert.equal(isPermanent({ responseCode: 550 }), true);
  assert.equal(isPermanent({ responseCode: 451 }), false);
  assert.equal(isPermanent({ code: "EAUTH", responseCode: 535 }), false); // credencial errada é problema nosso, não do destinatário
  assert.equal(isPermanent({ code: "ECONNECTION" }), false);
  assert.deepEqual([1, 2, 6, 9].map(backoffMinutes), [2, 4, 60, 60]);
});

test("validação de e-mail", () => {
  assert.equal(isEmail("a@b.com"), true);
  for (const bad of ["a@b", "a b@c.com", "a@b.com\r\nBcc: x@y.com", "<a@b.com>", "", "a@@b.com"]) assert.equal(isEmail(bad), false, bad);
});
