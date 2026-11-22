import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const routes = readFileSync(new URL("../../src/modules/users/users.routes.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("../../../admin/src/pages/Users.jsx", import.meta.url), "utf8");

test("rotas de sessões e desbloqueio existem e respeitam o escopo do perfil", () => {
  for (const r of ['router.get("/:id/sessions"', 'router.delete("/:id/sessions/:sessionId"', 'router.delete("/:id/sessions"', 'router.post("/:id/unlock"'])
    assert.ok(routes.includes(r), `falta ${r}`);
  // toda rota nova passa por loadTarget (admin só alcança contas role "partner")
  const block = routes.slice(routes.indexOf("const loadTarget"), routes.indexOf("router.patch("));
  assert.equal((block.match(/await loadTarget\(req\)/g) || []).length, 4);
  assert.match(block, /userScope === "partner" && target\.role !== "partner"\) throw forbiddenRole/);
});

test("encerrar sessão filtra pelo usuário alvo e gera auditoria", () => {
  assert.match(routes, /where: \{ id: sessionId, adminUserId: target\.id, revokedAt: null \}/);
  assert.match(routes, /user\.session\.revoke"/);
  assert.match(routes, /user\.session\.revoke_all"/);
  assert.match(routes, /user\.unlock"/);
  assert.match(routes, /failedLogins: 0, lockedUntil: null/);
});

test("painel mostra bloqueio de login e oferece sessões/desbloqueio", () => {
  assert.match(ui, /Desbloquear login/);
  assert.match(ui, /Sessões abertas/);
  assert.match(ui, /\/admin\/users\/\$\{u\.id\}\/unlock/);
  assert.match(ui, /Encerrar todas/);
});

test("sessões do Admin delegado validam propriedade da rede e não expõem refreshHash", () => {
  assert.match(routes, /partner\.ownerAdminId !== req\.user\.id/);
  assert.match(routes, /target\.partnerId !== req\.user\.partnerId/);
  assert.match(routes, /attributes: \["id", "audience", "ip", "userAgent", "createdAt", "expiresAt"\]/);
});
