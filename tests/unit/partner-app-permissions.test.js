import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercita as mesmas funções de permissão, sem precisar inicializar Sequelize/PostgreSQL.
const source = readFileSync(new URL('../../src/middleware/authenticate.js', import.meta.url), 'utf8');
const pick = (re, name) => {
  const found = source.match(re);
  assert.ok(found, `Não foi possível localizar ${name}`);
  return found[0].replace(/^export /, '');
};
const { PERMISSIONS, portalPermissionGate } = runInNewContext(`
  ${pick(/export const PERMISSIONS = \{[\s\S]*?\n\};/, 'PERMISSIONS')}
  ${pick(/export const can = \(user, perm\) => \{[\s\S]*?\n\};/, 'can')}
  ${pick(/export function portalPermissionGate\(req,_res,next\)\{[\s\S]*?\n\}/, 'portalPermissionGate')}
  ({ PERMISSIONS, portalPermissionGate });
`, {
  AppError: class AppError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  },
  adminHasNetworkPermission: () => false,
});

function allowed(path, method, permissions = PERMISSIONS.partner) {
  let passed = false;
  portalPermissionGate({ path, method, user: { role: 'partner', partnerId: 'p1', permissions } }, {}, () => { passed = true; });
  return passed;
}

test('parceiro padrão pode consultar apps e reivindicar uma vaga autorizada pelo plano', () => {
  assert.equal(allowed('/apps', 'GET'), true);
  assert.equal(allowed('/apps/claim', 'POST'), true);
  assert.equal(allowed('/apps/qualquer-app', 'PATCH'), true);
});

test('parceiro padrão mantém as rotas de códigos e TVs sem vínculo', () => {
  assert.equal(allowed('/codes', 'GET'), true);
  assert.equal(allowed('/devices/unlinked', 'GET'), true);
  assert.equal(allowed('/devices/unlinked/count', 'GET'), true);
});

test('papel personalizado continua limitado às permissões explicitamente concedidas', () => {
  assert.throws(() => allowed('/apps/claim', 'POST', ['partner:apps:read']), {code: 'FORBIDDEN', status: 403});
  assert.throws(() => allowed('/apps', 'GET', ['partner:devices:read']), {code: 'FORBIDDEN', status: 403});
  assert.equal(allowed('/apps', 'GET', ['partner:apps:read']), true);
});

test('o componente de Meus Apps não conserva vagas antigas em caso de erro', () => {
  const ui = readFileSync(new URL('../../../shared/ui/src/ClientApps.jsx', import.meta.url), 'utf8');
  assert.match(ui, /catch \(e\) \{ setState\(null\); setError\(`/);
  assert.match(ui, /api\('\/partner\/apps'\)/);
});
